import { db } from './database';
import { firestore } from './firebase';
import { collection, collectionGroup, getDocs, doc, setDoc, deleteDoc, getDoc, getDocFromServer } from 'firebase/firestore';

// 🌟 استدعاء دوال التشفير وفك التشفير اللي عملناهم
import { encryptData, decryptData } from '../encryption';
import { runIdMigration } from './migration';
import { ensureCleanChildId } from '../utils/idGenerator';
import { normalizeArabicName } from '../utils/nameUtils';

// 🧹 فلتر سحري لتنظيف الداتا (أسرع من السرياليزيشن)
const cleanData = (obj) => {
    const cleaned = { ...obj };
    for (const key in cleaned) {
        if (cleaned[key] === undefined) {
            delete cleaned[key];
        }
    }
    return cleaned;
};

// 🛠️ دالة مساعدة لتنسيق اللستة في التقرير عشان متكونش طويلة جداً ومزعجة
const formatDetailedList = (list) => {
    const safeList = list || [];
    if (safeList.length === 0) return "لا يوجد";
    if (safeList.length <= 4) return safeList.join('، ');
    return `${safeList.slice(0, 4).join('، ')} ... (+${safeList.length - 4} آخرين)`;
};

/**
 * 🛡️ Safely deletes a child and their associated attendance/grades from local Dexie.
 * Strictly validates childId to prevent IDBKeyRange DataErrors on invalid or NaN keys.
 * 
 * @param {any} rawId - The child ID
 */
export const safePurgeLocalChild = async (rawId) => {
    if (!rawId || (typeof rawId !== 'string' && typeof rawId !== 'number')) {
        console.warn('Skipping attendance cleanup for invalid childId:', rawId);
        return;
    }

    const childId = String(rawId).trim();
    if (!childId) {
        console.warn('Skipping attendance cleanup for empty childId:', rawId);
        return;
    }

    try {
        // 1. Delete child record by string ID
        await db.children.delete(childId);

        // Check if numeric ID exists (e.g. legacy numeric autoincrement ID)
        const numId = Number(childId);
        const hasValidNumId = !isNaN(numId) && Number.isFinite(numId);
        if (hasValidNumId) {
            await db.children.delete(numId);
        }

        // 2. Safely clean up attendance records
        try {
            await db.attendance.where('childId').equals(childId).delete();
            if (hasValidNumId) {
                await db.attendance.where('childId').equals(numId).delete();
            }
        } catch (attErr) {
            console.warn('Skipping attendance cleanup due to error:', attErr?.message);
        }

        // 3. Safely clean up grades records
        try {
            await db.grades.where('childId').equals(childId).delete();
            if (hasValidNumId) {
                await db.grades.where('childId').equals(numId).delete();
            }
        } catch (grdErr) {
            console.warn('Skipping grades cleanup due to error:', grdErr?.message);
        }
    } catch (err) {
        console.warn('Error during safePurgeLocalChild:', childId, err?.message);
    }
};

/**
 * Helper to decrypt and validate a Firestore document
 */
export const processCloudDoc = (docSnap) => {
    if (!docSnap || typeof docSnap.data !== 'function') return null;
    if (docSnap.id === '_placeholder') return null;
    const rawData = docSnap.data();
    if (!rawData) return null;
    if (rawData.placeholder || rawData.isPlaceholder) return null;
    
    let data = null;
    if (rawData.payload) {
        data = decryptData(rawData.payload);
        if (!data) {
            return null; // Safely ignore if decryption failed
        }
    } else {
        data = rawData;
    }
    
    if (data && typeof data === 'object' && !data.id && docSnap.id !== '_placeholder') {
        data.id = docSnap.id;
    }
    return data;
};

/**
 * 🎯 Strict Cloud-to-Local Reconciliation for a specific class (syncKey).
 * 
 * 1. Inserts/updates authoritative cloud children into Dexie (isDirty: false, isDeleted: false).
 * 2. Compares local Dexie records for that class against the cloud snapshot:
 *    - Soft-deleted records (isDeleted: true) are immediately purged.
 *    - Duplicate Name Safeguard: Any local child sharing the same normalized name
 *      with a cloud record but having a different ID (left over from ID migration or duplicate import)
 *      is immediately purged from Dexie using safePurgeLocalChild.
 *    - Ghost/Cloud-Deleted Safeguard: Any local record NOT in the cloud snapshot
 *      (and not pushed in this current sync cycle) is immediately purged.
 * 
 * @param {string} classKey - The syncKey for this class
 * @param {Array<object>} cloudChildrenForClass - Authoritative cloud children for this class
 * @param {Set<string>} [pushedChildrenIds] - IDs of records pushed in the current cycle
 * @returns {Promise<{ added: number, updated: number, purged: number }>}
 */
export async function reconcileClassChildren(classKey, cloudChildrenForClass = [], pushedChildrenIds = new Set()) {
    if (!classKey) return { added: 0, updated: 0, purged: 0 };
    const now = new Date().toISOString();
    let added = 0;
    let updated = 0;
    let purged = 0;

    const targetClassKey = String(classKey).trim();

    // 1. Build canonical lookup structures from Firestore snapshot
    const cloudDocIds = new Set();
    const cloudNameMap = new Map(); // normalizedName -> canonicalDocId
    const canonicalCloudMap = new Map(); // canonicalId -> childData

    for (const rawChild of cloudChildrenForClass) {
        if (!rawChild || rawChild.id === '_placeholder' || rawChild.isPlaceholder) continue;
        const cleanId = ensureCleanChildId(rawChild.id, rawChild.gender);
        const childData = {
            ...rawChild,
            id: cleanId,
            syncKey: targetClassKey,
            isDirty: false,
            isDeleted: false,
            updatedAt: rawChild.updatedAt || now
        };

        cloudDocIds.add(String(cleanId));
        cloudDocIds.add(String(rawChild.id));
        canonicalCloudMap.set(String(cleanId), childData);

        const normName = normalizeArabicName(childData.name);
        if (normName) {
            cloudNameMap.set(normName, String(cleanId));
        }
    }

    // 2. Put canonical cloud records into local Dexie
    for (const [canonicalId, cloudChild] of canonicalCloudMap.entries()) {
        if (cloudChild.isDeleted) {
            await safePurgeLocalChild(canonicalId);
            continue;
        }

        const existingLocal = await db.children.get(canonicalId);
        if (!existingLocal) {
            await db.children.put(cloudChild);
            added++;
        } else {
            // Overwrite local if not dirty or if we just pushed it or cloud is newer
            if (!existingLocal.isDirty || pushedChildrenIds.has(canonicalId)) {
                await db.children.put(cloudChild);
                updated++;
            }
        }
    }

    // 3. Query all local children in Dexie belonging to this class
    const localChildrenInClass = await db.children.where('syncKey').equals(targetClassKey).toArray();

    for (const localChild of localChildrenInClass) {
        const localIdStr = String(localChild.id);

        // a. Immediate purge if marked deleted
        if (localChild.isDeleted) {
            console.log(`🗑️ [Reconciliation] Purging deleted local child: ${localIdStr} (${localChild.name}) in ${targetClassKey}`);
            await safePurgeLocalChild(localChild.id);
            purged++;
            continue;
        }

        // b. Duplicate Name / Class Safeguard:
        // If this local record has the same normalized name as a canonical cloud record,
        // but has a different ID, keep only canonical and purge the duplicate!
        const normLocalName = normalizeArabicName(localChild.name);
        if (normLocalName && cloudNameMap.has(normLocalName)) {
            const canonicalId = cloudNameMap.get(normLocalName);
            if (localIdStr !== canonicalId && String(localChild.id) !== canonicalId) {
                console.log(`🧹 [Reconciliation] Duplicate name safeguard: Purging duplicate local child "${localChild.name}" (old ID: ${localChild.id}, canonical: ${canonicalId}) in ${targetClassKey}`);
                await safePurgeLocalChild(localChild.id);
                purged++;
                continue;
            }
        }

        // c. Ghost / Cloud-Deleted Safeguard:
        // If not in cloud snapshot and not pushed in this cycle, it was deleted on cloud or is a ghost!
        const isInCloud = cloudDocIds.has(localIdStr) || cloudDocIds.has(String(localChild.id));
        const wasJustPushed = pushedChildrenIds.has(localChild.id) || pushedChildrenIds.has(localIdStr);

        if (!isInCloud && !wasJustPushed) {
            console.log(`🗑️ [Reconciliation] Purging cloud-deleted/ghost child "${localChild.name}" (ID: ${localChild.id}) in ${targetClassKey}`);
            await safePurgeLocalChild(localChild.id);
            purged++;
            continue;
        }
    }

    return { added, updated, purged };
}

/**
 * 👑 Reconciles the local Dexie database across all registered classes (Osras).
 * Called by MasterDashboard and syncDataWithCloud when running full admin sync.
 * 
 * @param {Array<object>} osrasList - List of Osra objects with syncKey
 * @returns {Promise<{ success: boolean, totalPurged: number }>}
 */
export async function reconcileAllClassesWithCloud(osrasList = []) {
    if (!navigator.onLine) return { success: false, totalPurged: 0 };
    try {
        console.log(`🔄 [Global Reconciliation] Starting reconciliation across ${osrasList.length} classes...`);
        const pushedIds = new Set();
        const now = new Date().toISOString();

        // 1. Push any pending dirty records first so offline creations are never lost
        const dirtyKids = await db.children.filter(c => c.isDirty).toArray();
        for (const child of dirtyKids) {
            const targetKey = child.syncKey;
            if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;

            if (child.isDeleted) {
                try {
                    await deleteDoc(doc(firestore, 'Osras', targetKey, 'children', String(child.id)));
                } catch (_) {}
                await safePurgeLocalChild(child.id);
                pushedIds.add(child.id);
                continue;
            }

            try {
                const cleanId = ensureCleanChildId(child.id, child.gender);
                const payload = encryptData(cleanData({
                    ...child,
                    id: cleanId,
                    syncKey: targetKey,
                    isDirty: false,
                    isDeleted: false,
                    updatedAt: now
                }));
                await setDoc(doc(firestore, 'Osras', targetKey, 'children', String(cleanId)), { payload }, { merge: true });
                await db.children.update(child.id, { isDirty: false, updatedAt: now });
                pushedIds.add(cleanId);
                pushedIds.add(child.id);
            } catch (err) {
                console.warn(`Failed to push dirty child ${child.id}:`, err?.message);
            }
        }

        // 2. Per-class reconciliation for each class in osrasList
        let totalPurged = 0;
        const validSyncKeys = new Set();

        for (const osra of osrasList) {
            const syncKey = osra.syncKey;
            if (!syncKey || syncKey === 'MASTER_ACCESS' || syncKey === 'ADMIN_MODE' || syncKey === 'STAGE_ADMIN') continue;
            validSyncKeys.add(String(syncKey));

            try {
                const colRef = collection(firestore, 'Osras', syncKey, 'children');
                const snap = await getDocs(colRef);
                const cloudDocs = (snap.docs || [])
                    .map(processCloudDoc)
                    .filter(Boolean);

                const result = await reconcileClassChildren(syncKey, cloudDocs, pushedIds);
                totalPurged += result.purged;
            } catch (classErr) {
                console.warn(`⚠️ [Reconciliation] Error fetching cloud children for ${syncKey}:`, classErr?.message);
            }
        }

        // 3. Purge any orphan records in local Dexie whose syncKey does not belong to any active Osra
        if (validSyncKeys.size > 0) {
            const allLocal = await db.children.toArray();
            for (const c of allLocal) {
                const sKey = String(c.syncKey || '');
                if ((!sKey || !validSyncKeys.has(sKey)) && !pushedIds.has(c.id)) {
                    console.log(`🗑️ [Global Reconciliation] Purging orphan child "${c.name}" with unknown syncKey (${sKey}):`, c.id);
                    await safePurgeLocalChild(c.id);
                    totalPurged++;
                }
            }
        }

        console.log(`✅ [Global Reconciliation] Finished. Purged ${totalPurged} stale/ghost/duplicate records.`);
        return { success: true, totalPurged };
    } catch (err) {
        console.error('❌ [Global Reconciliation] Error:', err);
        return { success: false, error: err.message };
    }
}

const _syncDataWithCloud = async () => {
    try {
        // 🔐 1. هنجيب مفتاح الكلاود 
        const currentSyncKey = localStorage.getItem('currentSyncKey');

        if (!currentSyncKey) {
            return { success: false, message: "❌ غير مصرح! برجاء تسجيل الدخول بمفتاح الكلاود الخاص بأسرتك أولاً." };
        }

        // 🧹 Ensure all records locally and on cloud adhere to clean structured ID format before sync
        try {
            await runIdMigration();
        } catch (migErr) {
            console.warn('⚠️ [Sync] Pre-sync ID migration warning:', migErr);
        }

        // 🌟 تفاصيل العمليات (Detailed Logs)
        let pushLog = { children: [], attendance: [], events: [], grades: [], exams: [] };
        let pullLog = { 
            childrenAdded: [], childrenUpdated: [], 
            attendanceAdded: [], 
            eventsAdded: [], eventsUpdated: [],
            gradesAdded: [], gradesUpdated: [],
            examsAdded: [], examsUpdated: []
        };

        let pushedChildrenIds = new Set();
        let pushedAttendanceIds = new Set();
        let pushedEventsIds = new Set();
        let pushedGradeKeys = new Set();
        let pushedExamIds = new Set();

        let settingsUpdated = false;

        const currentServantObj = JSON.parse(localStorage.getItem('currentServant') || '{}');
        const allowedClasses = currentServantObj.allowedClasses || [];
        const isAdmin = currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE' || currentServantObj.role === 'كاهن' || currentServantObj.role === 'أدمن مساعد' || currentServantObj.role === 'Super Admin';
        const isStageAdmin = currentSyncKey === 'STAGE_ADMIN' || currentServantObj.role === 'أمين مرحلة';

        // 🌟 2. سحب إعدادات الكنيسة والخدام (System Settings) - FORCE FROM SERVER
        const settingsRef = doc(firestore, 'System', 'mainConfig');
        let settingsSnap;
        try {
            settingsSnap = await getDocFromServer(settingsRef); // جلب من السيرفر مباشرة لتفادي الكاش القديم
        } catch (e) {
            settingsSnap = await getDoc(settingsRef); // لو مفيش نت، نرجع للكاش
        }
        
        let activeOsrasList = [];

        if (settingsSnap.exists()) {
            const cloudSettings = settingsSnap.data();
            activeOsrasList = (cloudSettings.services || []).flatMap(s => s.osras || []).filter(o => o.syncKey);
            
            // 🚨 SESSION VALIDATION: AUTO-LOGOUT DELETED USERS
            const currentServantStr = localStorage.getItem('currentServant');
            
            if (currentServantStr && currentSyncKey && currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE') {
                const currentServant = JSON.parse(currentServantStr);
                const role = currentServant.role || '';
                
                if (role !== 'Super Admin' && role !== 'أدمن النظام') {
                    const servantsList = cloudSettings.servants || [];
                    const isStillExists = servantsList.some(s => {
                        if (currentServant.id && s.id) return s.id === currentServant.id;
                        return s.phone === currentServant.phone && s.name === currentServant.name;
                    });
                    
                    if (!isStillExists) {
                        console.warn("🔴 User deleted from cloud. Forcing auto-logout.");
                        localStorage.removeItem('currentServant');
                        localStorage.removeItem('currentSyncKey');
                        localStorage.removeItem('userPhone');
                        
                        await db.children.clear();
                        await db.attendance.clear();
                        await db.events.clear();
                        await db.exams.clear();
                        await db.grades.clear();
                        
                        window.location.href = '#/login';
                        window.location.reload(); 
                        return { success: false, message: "تم تسجيل الخروج لعدم وجود الحساب." };
                    }
                }
            }

            const localSettingsString = localStorage.getItem('appSettings');
            
            if (JSON.stringify(cloudSettings) !== localSettingsString) {
                const hasPendingSettings = localStorage.getItem('pendingStructureSync') === 'true';
                if (!hasPendingSettings) {
                    const localParsed = JSON.parse(localSettingsString || '{}');
                    const mergedSettings = { ...localParsed, ...cloudSettings };
                    localStorage.setItem('appSettings', JSON.stringify(mergedSettings));
                    settingsUpdated = true;

                    // Clear deprecated local db.servants
                    try {
                        await db.servants.clear();
                    } catch (e) {
                        console.warn('Failed to clear legacy db.servants', e);
                    }
                }
            }
        }

        const now = new Date().toISOString();
        const lastSyncTime = localStorage.getItem('lastSyncTime') || '1970-01-01T00:00:00.000Z';

        // 4. قراءة الداتا المحلية من الموبايل
        const localChildren = (await db.children.toArray()) || [];
        const localAttendance = (await db.attendance.toArray()) || [];
        const localEvents = (await db.events.toArray()) || [];
        const localExams = (await db.exams.toArray()) || [];
        const localGrades = (await db.grades.toArray()) || [];

        // 🚀🚀🚀 PHASE 1: الرفع للسحابة أولاً (PUSH FIRST) 🚀🚀🚀
        // رفع جميع التعديلات المحلية (isDirty) وحذف المقابر (Tombstones) قبل سحب أي داتا لتجنب ضياع شغل الأوفلاين

        // 1a. رفع الأطفال
        try {
            for (const child of localChildren) {
                if (!child.isDirty) continue;

                const targetKey = (isAdmin || isStageAdmin) ? (child.syncKey || currentSyncKey) : currentSyncKey;
                if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;

                const docRef = doc(firestore, 'Osras', targetKey, 'children', String(child.id));

                // 🪦 مقبرة الحذف (Tombstone): حذف من السحابة ثم مسح محلي فوراً
                if (child.isDeleted) {
                    try { await deleteDoc(docRef); } catch (_e) { /* ignore */ }
                    try {
                        const attSnap = await getDocs(collection(firestore, 'Osras', targetKey, 'attendance'));
                        const attToDelete = (attSnap.docs || []).filter(d => d.id.includes(`_${child.id}_`));
                        await Promise.all(attToDelete.map(d => deleteDoc(d.ref)));
                    } catch (_e) { /* ignore */ }

                    await safePurgeLocalChild(child.id);
                    pushLog.children.push(`🗑️${(child.name || '').split(' ')[0]}`);
                    pushedChildrenIds.add(String(child.id));
                    continue;
                }

                const cleanId = ensureCleanChildId(child.id, child.gender);
                const cloudDocRef = (cleanId !== child.id)
                    ? doc(firestore, 'Osras', targetKey, 'children', String(cleanId))
                    : docRef;

                const encryptedPayload = encryptData(cleanData({
                    ...child,
                    id: cleanId,
                    syncKey: targetKey,
                    isDirty: false,
                    isDeleted: false,
                    updatedAt: now
                }));

                await setDoc(cloudDocRef, { payload: encryptedPayload }, { merge: true });
                if (cleanId !== child.id) {
                    try { await deleteDoc(docRef); } catch (_) {}
                    await db.children.delete(child.id);
                    await db.children.put({ ...child, id: cleanId, syncKey: targetKey, isDirty: false, updatedAt: now });
                } else {
                    await db.children.update(child.id, { isDirty: false, updatedAt: now });
                }

                pushLog.children.push(child.name.split(' ')[0]);
                pushedChildrenIds.add(String(cleanId));
                pushedChildrenIds.add(String(child.id));
            }
        } catch (e) {
            console.error('Error syncing children push:', e);
        }

        // 1b. رفع الغياب
        try {
            for (const record of localAttendance) {
                if (!record.isDirty) continue;

                const targetKey = (isAdmin || isStageAdmin) ? (record.syncKey || currentSyncKey) : currentSyncKey;
                if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;

                const docId = `${record.date}_${record.childId}_${record.type}`;
                const docRef = doc(firestore, 'Osras', targetKey, 'attendance', docId);

                if (record.isDeleted) {
                    try { await deleteDoc(docRef); } catch (_e) { /* ignore */ }
                    await db.attendance.delete(record.id);
                    pushLog.attendance.push(`🗑️${record.date}`);
                    pushedAttendanceIds.add(docId);
                    continue;
                }

                const encryptedPayload = encryptData(cleanData({ ...record, syncKey: targetKey, isDirty: false, isDeleted: false, updatedAt: now }));
                await setDoc(docRef, { payload: encryptedPayload }, { merge: true });
                await db.attendance.update(record.id, { isDirty: false, updatedAt: now });
                pushLog.attendance.push(record.date);
                pushedAttendanceIds.add(docId);
            }
        } catch (e) {
            console.error('Error syncing attendance push:', e);
        }

        // 1c. رفع الأحداث والرحلات
        try {
            for (const event of localEvents) {
                if (!event.isDirty) continue;

                let targetKey = (isAdmin || isStageAdmin) ? (event.syncKey || currentSyncKey) : currentSyncKey;
                if (event.isGlobal || event.syncKey === 'global') targetKey = 'global';
                if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;

                const docRef = doc(firestore, 'Osras', targetKey, 'events', event.id.toString());

                if (event.isDeleted) {
                    try { await deleteDoc(docRef); } catch (_e) { /* ignore */ }
                    await db.events.delete(event.id);
                    pushLog.events.push(`🗑️${event.title || event.id}`);
                    pushedEventsIds.add(event.id);
                    continue;
                }

                const encryptedPayload = encryptData(cleanData({ ...event, syncKey: targetKey, isDirty: false, isDeleted: false, updatedAt: now }));
                await setDoc(docRef, { payload: encryptedPayload }, { merge: true });
                await db.events.update(event.id, { isDirty: false, updatedAt: now });
                pushLog.events.push(event.title);
                pushedEventsIds.add(event.id);
            }
        } catch (e) {
            console.error('Error syncing events push:', e);
        }

        // 1d. رفع الامتحانات
        try {
            for (const exam of localExams) {
                if (!exam.isDirty) continue;

                const targetKey = (isAdmin || isStageAdmin) ? (exam.syncKey || currentSyncKey) : currentSyncKey;
                if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;

                const examFirebaseId = exam.firebaseId || exam.id.toString();
                const docRef = doc(firestore, 'Osras', targetKey, 'exams', examFirebaseId);

                if (exam.isDeleted) {
                    try { await deleteDoc(docRef); } catch (_e) { /* ignore */ }
                    await db.exams.delete(exam.id);
                    pushLog.exams.push(`🗑️${exam.examName || exam.id}`);
                    pushedExamIds.add(examFirebaseId);
                    continue;
                }

                const examDataForCloud = cleanData({
                    id: examFirebaseId,
                    examName: exam.examName,
                    maxGrade: exam.maxGrade,
                    date: exam.date,
                    syncKey: targetKey,
                    updatedAt: exam.updatedAt || now
                });
                await setDoc(docRef, examDataForCloud, { merge: true });
                await db.exams.update(exam.id, { isDirty: false, updatedAt: now, firebaseId: examFirebaseId });
                pushLog.exams.push(exam.examName);
                pushedExamIds.add(examFirebaseId);
            }
        } catch (e) {
            console.error('Error syncing exams push:', e);
        }

        // 1e. رفع الدرجات
        try {
            for (const grade of localGrades) {
                if (!grade.isDirty) continue;

                const targetKey = (isAdmin || isStageAdmin) ? (grade.syncKey || currentSyncKey) : currentSyncKey;
                if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') continue;
                if (!grade.examId) continue;

                const gradeDocId = String(grade.childId);
                const docRef = doc(firestore, 'Osras', targetKey, 'exams', grade.examId, 'grades', gradeDocId);
                const gradeKey = `${grade.examId}_${grade.childId}`;

                if (grade.isDeleted) {
                    try { await deleteDoc(docRef); } catch (_e) { /* ignore */ }
                    await db.grades.delete(grade.id);
                    pushLog.grades.push(`🗑️${gradeKey}`);
                    pushedGradeKeys.add(gradeKey);
                    continue;
                }

                const gradeDataForCloud = cleanData({
                    childId: grade.childId,
                    grade: grade.grade,
                    examId: grade.examId,
                    examName: grade.examName,
                    maxGrade: grade.maxGrade,
                    date: grade.date,
                    syncKey: targetKey,
                    updatedAt: grade.updatedAt || now
                });
                const encryptedPayload = encryptData(gradeDataForCloud);
                await setDoc(docRef, { payload: encryptedPayload }, { merge: true });
                await db.grades.update(grade.id, { isDirty: false, updatedAt: now });
                pushLog.grades.push(`${grade.examName}/${grade.childId}`);
                pushedGradeKeys.add(gradeKey);
            }
        } catch (e) {
            console.error('Error syncing grades push:', e);
        }

        // 🌟🌟🌟 PHASE 2: السحب والمطابقة الصارمة (PULL & STRICT RECONCILIATION) 🌟🌟🌟

        // 2a. تحديد نطاق الفصول المطلوب مزامنتها
        let classesToSync = [];
        if (isAdmin) {
            if (activeOsrasList.length > 0) {
                classesToSync = activeOsrasList.map(o => o.syncKey).filter(Boolean);
            } else {
                const saved = localStorage.getItem('appSettings');
                const parsed = saved ? JSON.parse(saved) : {};
                classesToSync = (parsed.services || []).flatMap(s => s.osras || []).map(o => o.syncKey).filter(Boolean);
            }
        } else if (isStageAdmin) {
            classesToSync = allowedClasses;
        } else {
            classesToSync = [currentSyncKey];
        }

        // 2b. سحب ومطابقة الأطفال لكل فصل بدقة (Per-Class Reconciliation)
        for (const classKey of classesToSync) {
            if (!classKey || classKey === 'MASTER_ACCESS' || classKey === 'ADMIN_MODE' || classKey === 'STAGE_ADMIN') continue;

            try {
                const classChildrenCol = collection(firestore, 'Osras', classKey, 'children');
                const snap = await getDocs(classChildrenCol);
                const cloudDocs = (snap.docs || []).map(processCloudDoc).filter(Boolean);

                const recResult = await reconcileClassChildren(classKey, cloudDocs, pushedChildrenIds);
                if (recResult.added > 0) pullLog.childrenAdded.push(`${classKey}(+${recResult.added})`);
                if (recResult.updated > 0) pullLog.childrenUpdated.push(`${classKey}(~${recResult.updated})`);
            } catch (err) {
                console.warn(`Error pulling children for class ${classKey}:`, err?.message);
            }
        }

        // 2c. تنظيف أي مخدوم شاذ (Orphan) في الداتا بيز المحلية للأدمن
        if (isAdmin && classesToSync.length > 0) {
            const validKeySet = new Set(classesToSync.map(String));
            const allLocal = await db.children.toArray();
            for (const c of allLocal) {
                const sKey = String(c.syncKey || '');
                if ((!sKey || !validKeySet.has(sKey)) && !pushedChildrenIds.has(c.id)) {
                    console.log(`🗑️ [Sync Admin] Purging orphan child "${c.name}" with invalid syncKey (${sKey}):`, c.id);
                    await safePurgeLocalChild(c.id);
                }
            }
        }

        // 2d. سحب الغياب (Attendance Pull)
        let cloudAttendance = [];
        if (isAdmin) {
            const attSnap = await getDocs(collectionGroup(firestore, 'attendance'));
            cloudAttendance = (attSnap?.docs || []).map(processCloudDoc).filter(Boolean);
        } else if (isStageAdmin) {
            const attSnaps = await Promise.all(classesToSync.map(key => getDocs(collection(firestore, 'Osras', key, 'attendance'))));
            cloudAttendance = attSnaps.flatMap(snap => (snap?.docs || []).map(processCloudDoc)).filter(Boolean);
        } else {
            const attSnap = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'attendance'));
            cloudAttendance = (attSnap?.docs || []).map(processCloudDoc).filter(Boolean);
        }

        const localAttList = await db.attendance.toArray();
        const localAttendanceMap = new Map(localAttList.map(a => [`${a.date}_${a.childId}_${a.type}`, a]));

        for (const cAtt of cloudAttendance) {
            const docId = `${cAtt.date}_${cAtt.childId}_${cAtt.type}`;
            if (pushedAttendanceIds.has(docId)) continue;

            if (!localAttendanceMap.has(docId)) {
                const { id: _id, ...dataToInsert } = cAtt;
                const syncKeyToSave = (isAdmin || isStageAdmin) ? (dataToInsert.syncKey || currentSyncKey) : currentSyncKey;
                await db.attendance.add({ ...dataToInsert, syncKey: String(syncKeyToSave), isDirty: false, isDeleted: false, updatedAt: cAtt.updatedAt || now });
                pullLog.attendanceAdded.push(`${cAtt.childId}(${cAtt.date.slice(5)})`);
            }
        }

        // 2e. سحب الأحداث (Events Pull)
        let cloudEvents = [];
        if (isAdmin) {
            const eventsSnapshot = await getDocs(collectionGroup(firestore, 'events'));
            cloudEvents = (eventsSnapshot?.docs || []).map(processCloudDoc).filter(Boolean);
        } else if (isStageAdmin) {
            const eventsSnaps = await Promise.all(classesToSync.map(key => getDocs(collection(firestore, 'Osras', key, 'events'))));
            const globalEventsSnapshot = await getDocs(collection(firestore, 'Osras', 'global', 'events'));
            cloudEvents = [
                ...eventsSnaps.flatMap(snap => (snap?.docs || []).map(processCloudDoc)).filter(Boolean),
                ...(globalEventsSnapshot?.docs || []).map(processCloudDoc).filter(Boolean)
            ];
        } else {
            const eventsSnapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'events'));
            const globalEventsSnapshot = await getDocs(collection(firestore, 'Osras', 'global', 'events'));
            cloudEvents = [
                ...(eventsSnapshot?.docs || []).map(processCloudDoc).filter(Boolean),
                ...(globalEventsSnapshot?.docs || []).map(processCloudDoc).filter(Boolean)
            ];
        }

        const localEvList = await db.events.toArray();
        const localEventsMap = new Map(localEvList.map(e => [e.id, e]));

        for (const cloudEvent of cloudEvents) {
            if (pushedEventsIds.has(cloudEvent.id)) continue;

            const localMatch = localEventsMap.get(cloudEvent.id);
            let syncKeyToSave = (isAdmin || isStageAdmin) ? (cloudEvent.syncKey || currentSyncKey) : currentSyncKey;
            if (cloudEvent.isGlobal || cloudEvent.syncKey === 'global') syncKeyToSave = 'global';

            const eventToSave = { ...cloudEvent, syncKey: String(syncKeyToSave), isDirty: false, isDeleted: false, updatedAt: cloudEvent.updatedAt || now };

            if (!eventToSave.id) continue;

            if (!localMatch) {
                pullLog.eventsAdded.push(cloudEvent.title || 'حدث');
                await db.events.put(eventToSave);
            } else {
                const cloudUpdated = cloudEvent.updatedAt || '1970-01-01T00:00:00.000Z';
                if (cloudUpdated > lastSyncTime && !localMatch.isDirty) {
                    pullLog.eventsUpdated.push(cloudEvent.title || 'حدث');
                    await db.events.put(eventToSave);
                }
            }
        }

        // 2f. سحب الامتحانات والدرجات (Exams & Grades Pull)
        let cloudExamsList = [];
        if (isAdmin) {
            const examsSnapshot = await getDocs(collectionGroup(firestore, 'exams'));
            cloudExamsList = (examsSnapshot?.docs || [])
                .filter(d => d.ref.parent.id === 'exams' && d.id !== '_placeholder' && !d.data().placeholder)
                .map(d => ({ firebaseId: d.id, ...d.data() }))
                .filter(Boolean);
        } else if (isStageAdmin) {
            const examsSnaps = await Promise.all(classesToSync.map(key => getDocs(collection(firestore, 'Osras', key, 'exams'))));
            cloudExamsList = examsSnaps.flatMap(snap => (snap?.docs || []).filter(d => d.id !== '_placeholder' && !d.data().placeholder).map(d => ({ firebaseId: d.id, ...d.data() }))).filter(Boolean);
        } else {
            const examsSnapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'exams'));
            cloudExamsList = (examsSnapshot?.docs || []).filter(d => d.id !== '_placeholder' && !d.data().placeholder).map(d => ({ firebaseId: d.id, ...d.data() })).filter(Boolean);
        }

        const freshLocalExams = await db.exams.toArray();
        const localExamsMap = new Map(freshLocalExams.map(e => [e.firebaseId, e]));

        for (const cloudExam of cloudExamsList) {
            if (pushedExamIds.has(cloudExam.firebaseId)) continue;

            const localMatch = localExamsMap.get(cloudExam.firebaseId);
            const syncKeyToSave = (isAdmin || isStageAdmin) ? (cloudExam.syncKey || currentSyncKey) : currentSyncKey;
            const examToSave = {
                firebaseId: cloudExam.firebaseId,
                examName: cloudExam.examName,
                maxGrade: cloudExam.maxGrade,
                date: cloudExam.date,
                syncKey: String(syncKeyToSave),
                isDirty: false,
                isDeleted: false,
                updatedAt: cloudExam.updatedAt || now
            };

            if (!localMatch) {
                pullLog.examsAdded.push(cloudExam.examName);
                await db.exams.add(examToSave);
            } else {
                const cloudUpdated = cloudExam.updatedAt || '1970-01-01T00:00:00.000Z';
                if (cloudUpdated > lastSyncTime && !localMatch.isDirty) {
                    pullLog.examsUpdated.push(cloudExam.examName);
                    await db.exams.update(localMatch.id, examToSave);
                }
            }

            // سحب درجات هذا الامتحان
            try {
                const gradesColRef = collection(firestore, 'Osras', String(syncKeyToSave), 'exams', cloudExam.firebaseId, 'grades');
                const gradesSnapshot = await getDocs(gradesColRef);
                for (const gradeDoc of (gradesSnapshot?.docs || [])) {
                    if (gradeDoc.id === '_placeholder') continue;
                    const rawData = gradeDoc.data();
                    if (rawData.placeholder || rawData.isPlaceholder) continue;
                    const gradeData = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!gradeData || !gradeData.childId) continue;

                    const gradeKey = `${cloudExam.firebaseId}_${gradeData.childId}`;
                    if (pushedGradeKeys.has(gradeKey)) continue;

                    const localGradesFresh = await db.grades.toArray();
                    const localGradeMatch = localGradesFresh.find(
                        g => g.examId === cloudExam.firebaseId && String(g.childId) === String(gradeData.childId)
                    );

                    const gradeToSave = {
                        childId: gradeData.childId,
                        grade: gradeData.grade,
                        examId: cloudExam.firebaseId,
                        examName: gradeData.examName || cloudExam.examName,
                        maxGrade: gradeData.maxGrade || cloudExam.maxGrade,
                        date: gradeData.date || cloudExam.date,
                        syncKey: String(syncKeyToSave),
                        isDirty: false,
                        isDeleted: false,
                        updatedAt: gradeData.updatedAt || now
                    };

                    if (!localGradeMatch) {
                        pullLog.gradesAdded.push(`${cloudExam.examName}/${gradeData.childId}`);
                        await db.grades.add(gradeToSave);
                    } else {
                        const cloudUpdated = gradeData.updatedAt || '1970-01-01T00:00:00.000Z';
                        if (cloudUpdated > lastSyncTime && !localGradeMatch.isDirty) {
                            pullLog.gradesUpdated.push(`${cloudExam.examName}/${gradeData.childId}`);
                            await db.grades.update(localGradeMatch.id, gradeToSave);
                        }
                    }
                }
            } catch (_e) { /* ignore */ }
        }

        // 🕐 تحديث آخر وقت مزامنة
        localStorage.setItem('lastSyncTime', now);

        // 🌟 بناء رسالة التقرير المفصلة والنهائية
        let finalMessage = isAdmin
            ? "👑 تمت المزامنة المركزية والمطابقة بنجاح!\n\n"
            : "☁️ تمت المزامنة لأسرتك بنجاح!\n\n";

        if (settingsUpdated) finalMessage += "⚙️ تم سحب تحديثات الهيكل المركزي.\n\n";

        const hasPush = (pushLog.children?.length || 0) > 0 || (pushLog.attendance?.length || 0) > 0 || (pushLog.events?.length || 0) > 0 || (pushLog.grades?.length || 0) > 0 || (pushLog.exams?.length || 0) > 0;
        if (hasPush) {
            finalMessage += `⬆️ تم الرفع للسحابة:\n`;
            if ((pushLog.children?.length || 0) > 0) finalMessage += `👦 مخدومين (${(pushLog.children?.length || 0)}): ${formatDetailedList(pushLog.children)}\n`;
            if ((pushLog.attendance?.length || 0) > 0) finalMessage += `📅 غياب (${(pushLog.attendance?.length || 0)}): ${formatDetailedList(pushLog.attendance)}\n`;
            if ((pushLog.events?.length || 0) > 0) finalMessage += `🏕️ أحداث (${(pushLog.events?.length || 0)}): ${formatDetailedList(pushLog.events)}\n`;
            if ((pushLog.exams?.length || 0) > 0) finalMessage += `📝 امتحانات (${(pushLog.exams?.length || 0)}): ${formatDetailedList(pushLog.exams)}\n`;
            if ((pushLog.grades?.length || 0) > 0) finalMessage += `🎓 درجات (${(pushLog.grades?.length || 0)}): ${formatDetailedList(pushLog.grades)}\n`;
            finalMessage += `\n`;
        }

        const hasPull = (pullLog.childrenAdded?.length || 0) > 0 || (pullLog.childrenUpdated?.length || 0) > 0 || (pullLog.attendanceAdded?.length || 0) > 0 || (pullLog.eventsAdded?.length || 0) > 0 || (pullLog.eventsUpdated?.length || 0) > 0 || (pullLog.gradesAdded?.length || 0) > 0 || (pullLog.gradesUpdated?.length || 0) > 0 || (pullLog.examsAdded?.length || 0) > 0 || (pullLog.examsUpdated?.length || 0) > 0;
        if (hasPull) {
            finalMessage += `⬇️ تم الاستقبال والتحديث من السحابة:\n`;
            if ((pullLog.childrenAdded?.length || 0) > 0) finalMessage += `➕ فصول ومخدومين (${(pullLog.childrenAdded?.length || 0)}): ${formatDetailedList(pullLog.childrenAdded)}\n`;
            if ((pullLog.childrenUpdated?.length || 0) > 0) finalMessage += `🔄 تحديث مخدومين (${(pullLog.childrenUpdated?.length || 0)}): ${formatDetailedList(pullLog.childrenUpdated)}\n`;
            if ((pullLog.attendanceAdded?.length || 0) > 0) finalMessage += `➕ غياب مسجل (${(pullLog.attendanceAdded?.length || 0)}): ${formatDetailedList(pullLog.attendanceAdded)}\n`;
            if ((pullLog.eventsAdded?.length || 0) > 0) finalMessage += `➕ رحلات جديدة (${(pullLog.eventsAdded?.length || 0)}): ${formatDetailedList(pullLog.eventsAdded)}\n`;
            if ((pullLog.eventsUpdated?.length || 0) > 0) finalMessage += `🔄 تحديث رحلات (${(pullLog.eventsUpdated?.length || 0)}): ${formatDetailedList(pullLog.eventsUpdated)}\n`;
            if ((pullLog.examsAdded?.length || 0) > 0) finalMessage += `➕ امتحانات جديدة (${(pullLog.examsAdded?.length || 0)}): ${formatDetailedList(pullLog.examsAdded)}\n`;
            if ((pullLog.examsUpdated?.length || 0) > 0) finalMessage += `🔄 تحديث امتحانات (${(pullLog.examsUpdated?.length || 0)}): ${formatDetailedList(pullLog.examsUpdated)}\n`;
            if ((pullLog.gradesAdded?.length || 0) > 0) finalMessage += `➕ درجات جديدة (${(pullLog.gradesAdded?.length || 0)}): ${formatDetailedList(pullLog.gradesAdded)}\n`;
            if ((pullLog.gradesUpdated?.length || 0) > 0) finalMessage += `🔄 تحديث درجات (${(pullLog.gradesUpdated?.length || 0)}): ${formatDetailedList(pullLog.gradesUpdated)}\n`;
        }

        if (!hasPush && !hasPull && !settingsUpdated) {
            finalMessage = "✅ المزامنة تمت، جميع البيانات مطابقة للسحابة ومحدثة بالفعل.";
        }

        return { success: true, message: finalMessage };
    } catch (error) {
        console.error("Sync Error: ", error);
        return { success: false, message: `حصلت مشكلة: ${error.message}` };
    }
};

export const syncDataWithCloud = async (retryCount = 0) => {
    // 1. Immediate hardware check Before starting
    if (!navigator.onLine) {
        return { success: false, message: "⚠️ لا يوجد اتصال بالإنترنت. يرجى المحاولة لاحقاً." };
    }

    if (retryCount === 0) {
        window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'syncing' } }));
    }

    try {
        // We race the entire Sync process against a hard 60-second timeout
        const syncTask = _syncDataWithCloud();

        const timeoutTask = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("NETWORK_TIMEOUT")), 60000)
        );

        const result = await Promise.race([syncTask, timeoutTask]);
        
        if (result.success) {
            window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'success', time: Date.now() } }));
        } else {
            window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'error' } }));
        }
        
        return result;

    } catch (error) {
        if (error.message === "NETWORK_TIMEOUT") {
            if (retryCount < 1) {
                console.log("⏱️ Sync timeout. Retrying gracefully...");
                return await syncDataWithCloud(retryCount + 1);
            }
            window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'error' } }));
            return { success: false, message: "⏱️ انتهت مهلة الاتصال بالإنترنت أثناء الرفع. الرجاء التأكد من استقرار الشبكة." };
        }
        window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'error' } }));
        return { success: false, message: `حصلت مشكلة: ${error.message}` };
    }
};