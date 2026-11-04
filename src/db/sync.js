import { db } from './database';
import { firestore } from './firebase';
import { collection, collectionGroup, getDocs, doc, setDoc, deleteDoc, getDoc, getDocFromServer } from 'firebase/firestore';

// 🌟 استدعاء دوال التشفير وفك التشفير اللي عملناهم
import { encryptData, decryptData } from '../encryption';
import { runIdMigration } from './migration';
import { ensureCleanChildId, isCleanChildId } from '../utils/idGenerator';
import {
    normalizeArabicName,
    buildStrictDuplicateKey,
    areStrictDuplicateChildren,
    parseTimestampMs,
    getAllConfiguredOsras,
    resolveChildClassInfo,
    normalizeToValidSyncKey
} from '../utils/nameUtils';
import { isValidProfilePic, resolveProtectedProfilePic } from '../utils/imageUtils';

// 🔒 Global sync mutex promise locks to guarantee single execution
let activeSyncPromise = null;
let activeReconcilePromise = null;

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
 * Returns the current logged-in servant or admin display name for audit trails (`lastModifiedBy`, `deletedBy`).
 *
 * @returns {string}
 */
export function getCurrentServantModificationName() {
    if (typeof localStorage === 'undefined') return 'خادم';
    try {
        const raw = localStorage.getItem('currentServant');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.name) return String(parsed.name).trim();
            if (parsed?.role) return String(parsed.role).trim();
        }
        const syncKey = localStorage.getItem('currentSyncKey');
        if (syncKey === 'MASTER_ACCESS' || syncKey === 'ADMIN_MODE') {
            return 'الأب الكاهن / الأدمن العام';
        }
    } catch (_) {}
    return 'خادم الأسرة';
}

/**
 * Merges two child records (primary taking precedence over secondary),
 * strictly protecting `profilePic` so a partial update or empty photo NEVER wipes an existing photo
 * unless `photoExplicitlyRemoved === true`. Also preserves attendance summary dates if missing on primary.
 *
 * @param {Object} primary - Newer or winning record
 * @param {Object} secondary - Older or existing record
 * @returns {Object} Merged child object
 */
export function mergeChildRecordsPreservingPhoto(primary, secondary) {
    if (!primary && !secondary) return {};
    if (!secondary) return { ...primary };
    if (!primary) return { ...secondary };

    const protectedPic = resolveProtectedProfilePic(primary, secondary);

    const pickLaterDateStr = (d1, d2) => {
        if (!d1) return d2 || null;
        if (!d2) return d1 || null;
        return String(d1) >= String(d2) ? d1 : d2;
    };

    return {
        ...secondary,
        ...primary,
        profilePic: protectedPic,
        photoExplicitlyRemoved: primary.photoExplicitlyRemoved === true ? true : false,
        fatherPhone: primary.fatherPhone || secondary.fatherPhone || '',
        motherPhone: primary.motherPhone || secondary.motherPhone || '',
        childPhone: primary.childPhone || secondary.childPhone || '',
        phone: primary.phone || secondary.phone || '',
        whatsapp: primary.whatsapp || secondary.whatsapp || '',
        address: primary.address || secondary.address || '',
        birthDate: primary.birthDate || secondary.birthDate || '',
        schoolGrade: primary.schoolGrade || secondary.schoolGrade || '',
        notes: primary.notes || secondary.notes || '',
        last_liturgy: pickLaterDateStr(primary.last_liturgy, secondary.last_liturgy),
        last_service: pickLaterDateStr(primary.last_service, secondary.last_service),
        last_tasbeha: pickLaterDateStr(primary.last_tasbeha, secondary.last_tasbeha),
        last_visited: pickLaterDateStr(primary.last_visited, secondary.last_visited),
        streak: Math.max(Number(primary.streak) || 0, Number(secondary.streak) || 0)
    };
}

/**
 * Checks whether a deletion tombstone was created automatically by system reconciliation
 * rather than explicitly by a named servant.
 *
 * @param {Object} child
 * @returns {boolean}
 */
export function isSystemOrAccidentalDelete(child) {
    if (!child) return false;
    const by = String(child.deletedBy || '').trim();
    if (!by) return true;
    return (
        by.includes('تلقائي') ||
        by.includes('SYSTEM') ||
        by.includes('Reconciliation') ||
        by.includes('نقل إلى فصل آخر')
    );
}

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
    
    if (data && typeof data === 'object') {
        if (!data.id && docSnap.id !== '_placeholder') {
            data.id = docSnap.id;
        }
        // Merge top-level metadata flags if present (e.g., tombstone markers)
        if (rawData.isDeleted === true) data.isDeleted = true;
        if (rawData.movedTo) data.movedTo = rawData.movedTo;
        if (rawData.deletedAt && !data.deletedAt) data.deletedAt = rawData.deletedAt;
        if (rawData.deletedBy && !data.deletedBy) data.deletedBy = rawData.deletedBy;
        if (rawData.updatedAt && parseTimestampMs(rawData.updatedAt) > parseTimestampMs(data.updatedAt)) {
            data.updatedAt = rawData.updatedAt;
        }
        data._docId = docSnap.id;
        const parentSyncKey = docSnap.ref?.parent?.parent?.id;
        if (parentSyncKey) {
            data._collectionSyncKey = parentSyncKey;
        }
    }
    return data;
};

/**
 * Encodes a child object for Firestore storage with both encrypted `payload`
 * and top-level metadata (`syncKey`, `isDeleted`, `movedTo`, `updatedAt`) for fast, deterministic conflict resolution.
 */
export const buildCloudChildDocument = (childObj) => {
    const cleaned = cleanData(childObj);
    const payload = encryptData(cleaned);
    const docBody = {
        payload,
        syncKey: cleaned.syncKey || '',
        isDeleted: Boolean(cleaned.isDeleted),
        updatedAt: cleaned.updatedAt || Date.now()
    };
    if (cleaned.movedTo) docBody.movedTo = cleaned.movedTo;
    if (cleaned.deletedAt) docBody.deletedAt = cleaned.deletedAt;
    if (cleaned.deletedBy) docBody.deletedBy = cleaned.deletedBy;
    if (cleaned.lastModifiedBy) docBody.lastModifiedBy = cleaned.lastModifiedBy;
    return docBody;
};

/**
 * 🛡️ Strictly deduplicates a list of cloud children documents for a specific class (Osra).
 *
 * CRITICAL RULE (Part 3):
 * - NEVER deletes or merges children based on fuzzy name matching or empty phone numbers!
 * - ONLY deduplicates records if they share:
 *   1. The exact same `cloudId` / `id`, OR
 *   2. The exact same `syncKey` AND exact same normalized full 4-part name AND exact same non-empty phone number.
 * - When merging true exact duplicates, preserves the non-empty `profilePic`, combines attendance records,
 *   and keeps the active winner (`isDeleted: false` if any copy is active).
 * 
 * @param {string} syncKey - The Osra syncKey
 * @param {Array<object>} rawCloudChildren - Array of child objects from Firestore
 * @returns {Promise<{ canonicalChildren: Array<object>, purgedCount: number }>}
 */
export async function deduplicateCloudChildrenForClass(syncKey, rawCloudChildren = []) {
    if (!syncKey || !rawCloudChildren || rawCloudChildren.length === 0) {
        return { canonicalChildren: rawCloudChildren || [], purgedCount: 0 };
    }

    const classKey = String(syncKey).trim();
    const now = Date.now();

    // 1. Group ONLY by exact ID or strict 4-part-name + non-empty-phone key within this class
    const strictGroups = []; // Array of arrays of child objects
    const idToGroupIndex = new Map();
    const strictKeyToGroupIndex = new Map();

    for (const rawChild of rawCloudChildren) {
        if (!rawChild || rawChild.id === '_placeholder' || rawChild.isPlaceholder) continue;
        const cleanId = ensureCleanChildId(rawChild.id, rawChild.gender);
        const child = {
            ...rawChild,
            id: cleanId,
            syncKey: classKey,
            _rawId: rawChild._docId || rawChild.id
        };

        // Do not merge deleted tombstones with active records unless they share the exact same ID
        const idKey = String(cleanId).trim();
        const strictCompositeKey = !child.isDeleted ? buildStrictDuplicateKey(child, classKey) : null;

        let matchedGroupIdx = -1;
        if (idKey && idToGroupIndex.has(idKey)) {
            matchedGroupIdx = idToGroupIndex.get(idKey);
        } else if (strictCompositeKey && strictKeyToGroupIndex.has(strictCompositeKey)) {
            matchedGroupIdx = strictKeyToGroupIndex.get(strictCompositeKey);
        }

        if (matchedGroupIdx === -1) {
            matchedGroupIdx = strictGroups.length;
            strictGroups.push([child]);
        } else {
            strictGroups[matchedGroupIdx].push(child);
        }

        if (idKey) idToGroupIndex.set(idKey, matchedGroupIdx);
        if (strictCompositeKey) strictKeyToGroupIndex.set(strictCompositeKey, matchedGroupIdx);
    }

    // 2. Identify winners and losers deterministically
    const canonicalChildren = [];
    const loserToWinnerMap = new Map(); // loserId -> winnerId
    const losersToDelete = []; // array of { id, rawId }
    const winnersToUpdateInCloud = [];

    for (const group of strictGroups) {
        if (group.length === 1) {
            canonicalChildren.push(group[0]);
            continue;
        }

        // Deterministically sort copies to pick the best winner
        const sorted = [...group].sort((a, b) => {
            // a. If same ID, prefer newer timestamp; if different IDs in strict duplicate group, prefer non-deleted active record
            if (Boolean(a.isDeleted) !== Boolean(b.isDeleted)) {
                return a.isDeleted ? 1 : -1;
            }
            // b. Prefer record with valid profilePic
            const aPic = isValidProfilePic(a.profilePic);
            const bPic = isValidProfilePic(b.profilePic);
            if (aPic !== bPic) return aPic ? -1 : 1;
            // c. Prefer clean structured ID format
            const aClean = isCleanChildId(a.id);
            const bClean = isCleanChildId(b.id);
            if (aClean !== bClean) return aClean ? -1 : 1;
            // d. Prefer latest updatedAt (numeric ms comparison)
            const aTime = parseTimestampMs(a.updatedAt);
            const bTime = parseTimestampMs(b.updatedAt);
            if (aTime !== bTime) return bTime - aTime;
            // e. Deterministic fallback by ID
            return String(b.id || '').localeCompare(String(a.id || ''));
        });

        let winner = { ...sorted[0] };
        const winnerId = String(winner.id);
        let mergedAny = false;

        for (let i = 1; i < sorted.length; i++) {
            const loser = sorted[i];
            winner = mergeChildRecordsPreservingPhoto(winner, loser);
            // When merging true duplicates where at least one is active, keep record active
            if (!sorted[0].isDeleted) {
                winner.isDeleted = false;
                winner.movedTo = null;
            }
            mergedAny = true;

            const loserId = String(loser.id);
            const loserRawId = String(loser._rawId || loser.id);
            if (loserId !== winnerId) {
                loserToWinnerMap.set(loserId, winnerId);
                losersToDelete.push({ id: loserId, rawId: loserRawId });
            } else if (loserRawId !== winnerId) {
                loserToWinnerMap.set(loserRawId, winnerId);
                losersToDelete.push({ id: loserRawId, rawId: loserRawId });
            }
        }

        if (mergedAny) {
            winnersToUpdateInCloud.push(winner);
        }
        canonicalChildren.push(winner);
    }

    if (loserToWinnerMap.size === 0) {
        return { canonicalChildren, purgedCount: 0 };
    }

    console.log(`🧹 [Strict Deduplication] Resolving ${loserToWinnerMap.size} exact duplicate cloud records in ${classKey}...`);

    // 3. Save merged winner data (preserving profilePic & combined fields) and remove exact duplicate loser docs
    if (navigator.onLine) {
        try {
            await Promise.all(winnersToUpdateInCloud.map(async w => {
                try {
                    const wRef = doc(firestore, 'Osras', classKey, 'children', String(w.id));
                    const { _rawId, _docId, _collectionSyncKey, ...cleanWinner } = w;
                    await setDoc(wRef, buildCloudChildDocument({
                        ...cleanWinner,
                        id: String(w.id),
                        syncKey: classKey,
                        isDirty: false
                    }), { merge: true });
                } catch (_) {}
            }));

            await Promise.all(losersToDelete.map(async loser => {
                try {
                    await deleteDoc(doc(firestore, 'Osras', classKey, 'children', String(loser.id)));
                    if (loser.rawId && String(loser.rawId) !== String(loser.id)) {
                        await deleteDoc(doc(firestore, 'Osras', classKey, 'children', String(loser.rawId)));
                    }
                } catch (delErr) {
                    console.warn(`⚠️ Failed deleting exact duplicate cloud child doc ${loser.id}:`, delErr?.message);
                }
            }));
        } catch (delErr) {
            console.warn(`⚠️ Cloud delete duplicate children warning:`, delErr?.message);
        }

        // 4. Combine & migrate cloud attendance references in Firestore from loser ID to winner ID
        try {
            const attSnap = await getDocs(collection(firestore, 'Osras', classKey, 'attendance'));
            for (const aDoc of (attSnap.docs || [])) {
                if (aDoc.id === '_placeholder') continue;
                const rawAtt = aDoc.data();
                let attData = rawAtt?.payload ? decryptData(rawAtt.payload) : rawAtt;
                if (!attData) continue;

                const cId = String(attData.childId || '');
                let matchedWinnerId = loserToWinnerMap.get(cId);

                if (!matchedWinnerId) {
                    for (const [loserId, wId] of loserToWinnerMap.entries()) {
                        if (aDoc.id.includes(`_${loserId}_`)) {
                            matchedWinnerId = wId;
                            break;
                        }
                    }
                }

                if (matchedWinnerId) {
                    const newAttDocId = `${attData.date}_${matchedWinnerId}_${attData.type}`;
                    const updatedAtt = {
                        ...attData,
                        childId: matchedWinnerId,
                        syncKey: classKey,
                        isDirty: false,
                        isDeleted: false,
                        updatedAt: now
                    };
                    const newAttRef = doc(firestore, 'Osras', classKey, 'attendance', newAttDocId);
                    await setDoc(newAttRef, { payload: encryptData(cleanData(updatedAtt)) }, { merge: true });
                    try {
                        await deleteDoc(aDoc.ref);
                    } catch (_) {}
                }
            }
        } catch (attMigErr) {
            console.warn(`⚠️ Cloud attendance migration warning in ${classKey}:`, attMigErr?.message);
        }

        // 5. Combine & migrate cloud exam grades in Firestore
        try {
            const examsSnap = await getDocs(collection(firestore, 'Osras', classKey, 'exams'));
            for (const examDoc of (examsSnap.docs || [])) {
                const examId = examDoc.id;
                for (const [loserId, wId] of loserToWinnerMap.entries()) {
                    const oldGradeRef = doc(firestore, 'Osras', classKey, 'exams', examId, 'grades', String(loserId));
                    try {
                        const oldGradeSnap = await getDoc(oldGradeRef);
                        if (oldGradeSnap.exists()) {
                            const rawG = oldGradeSnap.data();
                            const gData = rawG?.payload ? decryptData(rawG.payload) : rawG;
                            if (gData) {
                                const updatedGrade = { ...gData, childId: wId, updatedAt: now };
                                const newGradeRef = doc(firestore, 'Osras', classKey, 'exams', examId, 'grades', String(wId));
                                await setDoc(newGradeRef, { payload: encryptData(cleanData(updatedGrade)) }, { merge: true });
                                await deleteDoc(oldGradeRef);
                            }
                        }
                    } catch (_) {}
                }
            }
        } catch (grdMigErr) {
            console.warn(`⚠️ Cloud grades migration warning in ${classKey}:`, grdMigErr?.message);
        }
    }

    // 6. Combine local Dexie attendance from losers to winners
    try {
        const allLocalAtt = await db.attendance.toArray();
        for (const att of allLocalAtt) {
            const cId = String(att.childId || '');
            if (loserToWinnerMap.has(cId)) {
                await db.attendance.update(att.id, { childId: loserToWinnerMap.get(cId), updatedAt: now });
            }
        }
    } catch (_) {}

    // 7. Combine local Dexie grades from losers to winners
    try {
        const allLocalGrades = await db.grades.toArray();
        for (const grd of allLocalGrades) {
            const cId = String(grd.childId || '');
            if (loserToWinnerMap.has(cId)) {
                await db.grades.update(grd.id, { childId: loserToWinnerMap.get(cId), updatedAt: now });
            }
        }
    } catch (_) {}

    // 8. Safely purge only exact-duplicate loser records locally
    for (const loser of losersToDelete) {
        if (!loserToWinnerMap.has(loser.id)) continue;
        const winnerId = loserToWinnerMap.get(loser.id);
        if (String(loser.id) !== String(winnerId)) {
            await safePurgeLocalChild(loser.id);
        }
    }

    return { canonicalChildren, purgedCount: loserToWinnerMap.size };
}

/**
 * 🛡️ Deterministically resolves cross-class duplicate child documents across multiple Firestore classes.
 *
 * CRITICAL RULE (Part 2.3):
 * If the same child `id` / `cloudId` is found in two different `Osras/{syncKey}/children` collections:
 * - Compare `updatedAt` timestamps (via `parseTimestampMs`).
 * - Keep the copy in the class with the NEWEST `updatedAt` (and where `movedTo` does not point elsewhere and `isDeleted` is not true).
 * - Preserve any non-empty `profilePic` from all copies.
 * - Automatically tombstone the stale ghost copy in the older class subcollection (`isDeleted: true, movedTo: winnerSyncKey, updatedAt: Date.now()`)
 *   so the child stops jumping between classes!
 *
 * @param {Map<string, Array<object>>} classDocsBySyncKey - Map of syncKey -> array of cloud child docs
 * @returns {Promise<{ resolvedClassDocsMap: Map<string, Array<object>>, authoritativeClassByChildId: Map<string, string>, crossClassResolvedCount: number }>}
 */
export async function resolveCrossClassDuplicatesAcrossCloud(classDocsBySyncKey) {
    const copiesByChildId = new Map(); // cleanId -> Array<{ syncKey, docData }>

    for (const [syncKey, docsList] of classDocsBySyncKey.entries()) {
        for (const rawDoc of (docsList || [])) {
            if (!rawDoc || rawDoc.id === '_placeholder' || rawDoc.isPlaceholder) continue;
            const cleanId = String(ensureCleanChildId(rawDoc.id, rawDoc.gender));
            if (!copiesByChildId.has(cleanId)) {
                copiesByChildId.set(cleanId, []);
            }
            copiesByChildId.get(cleanId).push({
                syncKey: String(syncKey),
                docData: { ...rawDoc, id: cleanId }
            });
        }
    }

    const authoritativeClassByChildId = new Map();
    const resolvedClassDocsMap = new Map();
    for (const syncKey of classDocsBySyncKey.keys()) {
        resolvedClassDocsMap.set(String(syncKey), []);
    }

    let crossClassResolvedCount = 0;
    const now = Date.now();

    for (const [childId, entries] of copiesByChildId.entries()) {
        if (entries.length === 1) {
            const single = entries[0];
            // If this single copy was not deleted, record its authoritative class
            if (!single.docData.isDeleted) {
                authoritativeClassByChildId.set(childId, single.syncKey);
            }
            resolvedClassDocsMap.get(single.syncKey)?.push(single.docData);
            continue;
        }

        // Multiple copies across different classes (or same class)!
        // Sort deterministically:
        // 1. Prefer active (!isDeleted) where movedTo does not point elsewhere
        // 2. If one copy has movedTo pointing to another class in entries, prefer that target class
        // 3. Compare updatedAt timestamps (newest wins)
        const pointedTargets = new Set(
            entries
                .map(e => e.docData.movedTo)
                .filter(Boolean)
                .map(String)
        );

        const sorted = [...entries].sort((a, b) => {
            const aActive = !a.docData.isDeleted && (!a.docData.movedTo || a.docData.movedTo === a.syncKey);
            const bActive = !b.docData.isDeleted && (!b.docData.movedTo || b.docData.movedTo === b.syncKey);
            if (aActive !== bActive) return aActive ? -1 : 1;

            const aIsPointedTarget = pointedTargets.has(a.syncKey) && !a.docData.isDeleted;
            const bIsPointedTarget = pointedTargets.has(b.syncKey) && !b.docData.isDeleted;
            if (aIsPointedTarget !== bIsPointedTarget) return aIsPointedTarget ? -1 : 1;

            const aTime = parseTimestampMs(a.docData.updatedAt);
            const bTime = parseTimestampMs(b.docData.updatedAt);
            if (aTime !== bTime) return bTime - aTime;

            return String(b.syncKey).localeCompare(String(a.syncKey));
        });

        const winnerEntry = sorted[0];
        const winnerSyncKey = winnerEntry.syncKey;
        let mergedWinnerDoc = {
            ...winnerEntry.docData,
            id: childId,
            syncKey: winnerSyncKey
        };

        // Merge any non-empty profilePic and fields from older copies so photo is NEVER lost
        for (let i = 1; i < sorted.length; i++) {
            mergedWinnerDoc = mergeChildRecordsPreservingPhoto(mergedWinnerDoc, sorted[i].docData);
        }
        mergedWinnerDoc.syncKey = winnerSyncKey;

        if (!mergedWinnerDoc.isDeleted) {
            authoritativeClassByChildId.set(childId, winnerSyncKey);
        }

        resolvedClassDocsMap.get(winnerSyncKey)?.push(mergedWinnerDoc);

        // Tombstone any active ghost copies in other classes so the child never exists as active in two classes
        for (let i = 1; i < sorted.length; i++) {
            const staleEntry = sorted[i];
            if (staleEntry.syncKey === winnerSyncKey) continue;

            if (!staleEntry.docData.isDeleted || staleEntry.docData.movedTo !== winnerSyncKey) {
                crossClassResolvedCount++;
                const tombstoneDoc = {
                    ...staleEntry.docData,
                    id: childId,
                    syncKey: staleEntry.syncKey,
                    isDeleted: true,
                    movedTo: winnerSyncKey,
                    deletedAt: now,
                    deletedBy: 'نقل إلى فصل آخر',
                    updatedAt: now
                };

                if (navigator.onLine) {
                    try {
                        const staleRef = doc(firestore, 'Osras', staleEntry.syncKey, 'children', childId);
                        const { _rawId, _docId, _collectionSyncKey, ...cleanTombstone } = tombstoneDoc;
                        await setDoc(staleRef, buildCloudChildDocument(cleanTombstone), { merge: true });
                    } catch (err) {
                        console.warn(`⚠️ Failed to tombstone stale cross-class copy of ${childId} in ${staleEntry.syncKey}:`, err?.message);
                    }
                }
            }
        }

        // If winner was enriched with a recovered profilePic from a stale copy, persist it to winner class
        if (
            navigator.onLine &&
            isValidProfilePic(mergedWinnerDoc.profilePic) &&
            !isValidProfilePic(winnerEntry.docData.profilePic)
        ) {
            try {
                const winnerRef = doc(firestore, 'Osras', winnerSyncKey, 'children', childId);
                const { _rawId, _docId, _collectionSyncKey, ...cleanWinner } = mergedWinnerDoc;
                await setDoc(winnerRef, buildCloudChildDocument(cleanWinner), { merge: true });
            } catch (_) {}
        }
    }

    if (crossClassResolvedCount > 0) {
        console.log(`🛡️ [Cross-Class Dedup] Tombstoned ${crossClassResolvedCount} stale cross-class ghost copies.`);
    }

    return { resolvedClassDocsMap, authoritativeClassByChildId, crossClassResolvedCount };
}

/**
 * 🎯 Strict Cloud-to-Local Reconciliation for a specific class (syncKey).
 *
 * Guarantees:
 * 1. Only deduplicates true exact duplicates (same ID or same syncKey + 4-part name + non-empty phone).
 * 2. Protects `profilePic` during every merge (`resolveProtectedProfilePic`).
 * 3. Propagates `isDeleted: true` tombstones deterministically without resurrecting deleted records.
 * 4. Respects `authoritativeClassByChildId` so an older copy or tombstone in Class A NEVER overwrites or deletes
 *    a child whose active record is now in Class B.
 * 
 * @param {string} classKey - The syncKey for this class
 * @param {Array<object>} cloudChildrenForClass - Authoritative cloud children for this class
 * @param {Set<string>} [pushedChildrenIds] - IDs of records pushed in the current cycle
 * @param {Map<string, string>|null} [authoritativeClassByChildId] - Optional map of childId -> winning syncKey across all classes
 * @returns {Promise<{ added: number, updated: number, purged: number }>}
 */
export async function reconcileClassChildren(
    classKey,
    cloudChildrenForClass = [],
    pushedChildrenIds = new Set(),
    authoritativeClassByChildId = null
) {
    if (!classKey) return { added: 0, updated: 0, purged: 0 };
    const now = Date.now();
    let added = 0;
    let updated = 0;
    let purged = 0;

    const targetClassKey = String(classKey).trim();

    // 0. Strict Cloud Deduplication within this class
    const { canonicalChildren, purgedCount } = await deduplicateCloudChildrenForClass(targetClassKey, cloudChildrenForClass);
    purged += purgedCount;

    // 1. Build canonical lookup structures from deduplicated snapshot
    const cloudDocIds = new Set();
    const cloudStrictKeyMap = new Map(); // strictDuplicateKey -> canonicalDocId
    const canonicalCloudMap = new Map(); // canonicalId -> childData

    for (const rawChild of canonicalChildren) {
        if (!rawChild || rawChild.id === '_placeholder' || rawChild.isPlaceholder) continue;
        const cleanId = String(ensureCleanChildId(rawChild.id, rawChild.gender));
        const { _rawId, _docId, _collectionSyncKey, ...cleanRaw } = rawChild;
        const childData = {
            ...cleanRaw,
            id: cleanId,
            syncKey: targetClassKey,
            isDirty: false,
            isDeleted: Boolean(rawChild.isDeleted),
            updatedAt: rawChild.updatedAt || now
        };

        cloudDocIds.add(cleanId);
        if (rawChild.id) cloudDocIds.add(String(rawChild.id));
        canonicalCloudMap.set(cleanId, childData);

        if (!childData.isDeleted) {
            const strictKey = buildStrictDuplicateKey(childData, targetClassKey);
            if (strictKey) {
                cloudStrictKeyMap.set(strictKey, cleanId);
            }
        }
    }

    // 2. Reconcile canonical cloud records into local Dexie
    for (const [canonicalId, cloudChild] of canonicalCloudMap.entries()) {
        // Cross-class guard: if this child's authoritative active record belongs to a DIFFERENT class,
        // ignore stale copies or move-tombstones from this class!
        if (authoritativeClassByChildId && authoritativeClassByChildId.has(canonicalId)) {
            const winningClass = authoritativeClassByChildId.get(canonicalId);
            if (winningClass && winningClass !== targetClassKey) {
                continue;
            }
        }

        const existingLocal = await db.children.get(canonicalId);

        // Additional cross-class guard for single-class or sequential sync:
        // If local Dexie already has this child in a DIFFERENT class with a newer timestamp (or movedTo pointing there),
        // do NOT let an older record or tombstone from targetClassKey overwrite it!
        if (existingLocal && existingLocal.syncKey && String(existingLocal.syncKey) !== targetClassKey) {
            const localTime = parseTimestampMs(existingLocal.updatedAt);
            const cloudTime = parseTimestampMs(cloudChild.updatedAt);
            if (
                existingLocal.isDirty ||
                cloudChild.movedTo === existingLocal.syncKey ||
                (cloudChild.isDeleted && !existingLocal.isDeleted && localTime >= cloudTime) ||
                localTime > cloudTime
            ) {
                continue;
            }
        }

        // Handle soft-deleted cloud tombstone
        if (cloudChild.isDeleted) {
            // Only allow local to stay active if an Admin explicitly clicked "Restore" more recently than deletedAt
            const restoredTime = parseTimestampMs(existingLocal?.restoredAt);
            const deletedTime = Math.max(parseTimestampMs(cloudChild.deletedAt), parseTimestampMs(cloudChild.updatedAt));
            if (existingLocal && existingLocal.isDirty && restoredTime > deletedTime) {
                continue;
            }

            if (existingLocal) {
                const mergedTombstone = mergeChildRecordsPreservingPhoto(cloudChild, existingLocal);
                await db.children.put({
                    ...mergedTombstone,
                    id: canonicalId,
                    syncKey: targetClassKey,
                    isDeleted: true,
                    deletedAt: cloudChild.deletedAt || existingLocal.deletedAt || now,
                    deletedBy: cloudChild.deletedBy || existingLocal.deletedBy || '',
                    movedTo: cloudChild.movedTo || existingLocal.movedTo || null,
                    isDirty: false
                });
                if (!existingLocal.isDeleted) {
                    purged++;
                }
            } else {
                // Keep tombstone record in local Dexie so Recovery Center can inspect/restore it if needed
                await db.children.put({
                    ...cloudChild,
                    id: canonicalId,
                    syncKey: targetClassKey,
                    isDeleted: true,
                    isDirty: false
                });
            }
            continue;
        }

        // Cloud record is active (!cloudChild.isDeleted):
        if (!existingLocal) {
            await db.children.put(cloudChild);
            added++;
        } else {
            // CRITICAL (Part 4.2): NEVER resurrect a record where local `isDeleted === true`
            // unless an Admin explicitly clicked "Restore" on cloud (`cloudChild.restoredAt > existingLocal.deletedAt`)!
            if (existingLocal.isDeleted) {
                const cloudRestoredAt = parseTimestampMs(cloudChild.restoredAt);
                const localDeletedAt = Math.max(parseTimestampMs(existingLocal.deletedAt), parseTimestampMs(existingLocal.updatedAt));
                if (cloudRestoredAt > localDeletedAt) {
                    const mergedRestored = mergeChildRecordsPreservingPhoto(cloudChild, existingLocal);
                    await db.children.put({
                        ...mergedRestored,
                        id: canonicalId,
                        syncKey: targetClassKey,
                        isDeleted: false,
                        deletedAt: null,
                        deletedBy: null,
                        movedTo: null,
                        isDirty: false
                    });
                    updated++;
                } else if (navigator.onLine) {
                    // Push the local deletion tombstone back to cloud so the ghost record stops returning!
                    try {
                        const tombstonePayload = {
                            ...mergeChildRecordsPreservingPhoto(existingLocal, cloudChild),
                            id: canonicalId,
                            syncKey: targetClassKey,
                            isDeleted: true,
                            deletedAt: existingLocal.deletedAt || now,
                            deletedBy: existingLocal.deletedBy || getCurrentServantModificationName(),
                            updatedAt: Math.max(localDeletedAt, parseTimestampMs(cloudChild.updatedAt)) + 1,
                            isDirty: false
                        };
                        await setDoc(
                            doc(firestore, 'Osras', targetClassKey, 'children', canonicalId),
                            buildCloudChildDocument(tombstonePayload),
                            { merge: true }
                        );
                        await db.children.put(tombstonePayload);
                    } catch (_) {}
                }
                continue;
            }

            // Both cloud and local are active: merge while ALWAYS protecting `profilePic`
            const localTime = parseTimestampMs(existingLocal.updatedAt);
            const cloudTime = parseTimestampMs(cloudChild.updatedAt);

            if (!existingLocal.isDirty || pushedChildrenIds.has(canonicalId) || cloudTime >= localTime) {
                const merged = mergeChildRecordsPreservingPhoto(cloudChild, existingLocal);
                const finalRecord = {
                    ...merged,
                    id: canonicalId,
                    syncKey: targetClassKey,
                    isDirty: false,
                    isDeleted: false
                };
                await db.children.put(finalRecord);

                // If local had a valid profilePic that was missing on cloud, push it back to cloud to heal cloud photo!
                if (
                    navigator.onLine &&
                    !isValidProfilePic(cloudChild.profilePic) &&
                    isValidProfilePic(existingLocal.profilePic) &&
                    cloudChild.photoExplicitlyRemoved !== true
                ) {
                    try {
                        await setDoc(
                            doc(firestore, 'Osras', targetClassKey, 'children', canonicalId),
                            buildCloudChildDocument(finalRecord),
                            { merge: true }
                        );
                    } catch (_) {}
                }
                updated++;
            } else {
                // Local is dirty and newer than cloud: still protect local photo if local photo is empty and cloud has one
                if (!isValidProfilePic(existingLocal.profilePic) && isValidProfilePic(cloudChild.profilePic) && existingLocal.photoExplicitlyRemoved !== true) {
                    await db.children.update(canonicalId, {
                        profilePic: cloudChild.profilePic.trim()
                    });
                }
            }
        }
    }

    // 3. Inspect local children in Dexie claiming to belong to `targetClassKey`
    const localChildrenInClass = await db.children.where('syncKey').equals(targetClassKey).toArray();
    let localPurged = 0;

    for (const localChild of localChildrenInClass) {
        const localIdStr = String(localChild.id);
        if (localChild.isDeleted || localChild.isDirty) continue;

        // a. Strict Duplicate Safeguard (ONLY when 4-part name + non-empty phone match an existing cloud record in same class)
        const strictLocalKey = buildStrictDuplicateKey(localChild, targetClassKey);
        if (strictLocalKey && cloudStrictKeyMap.has(strictLocalKey)) {
            const canonicalId = cloudStrictKeyMap.get(strictLocalKey);
            if (localIdStr !== canonicalId) {
                const canonicalCloud = canonicalCloudMap.get(canonicalId);
                if (canonicalCloud && areStrictDuplicateChildren(localChild, canonicalCloud, targetClassKey)) {
                    const mergedWinner = mergeChildRecordsPreservingPhoto(canonicalCloud, localChild);
                    await db.children.put({
                        ...mergedWinner,
                        id: canonicalId,
                        syncKey: targetClassKey,
                        isDirty: false,
                        isDeleted: false
                    });
                    if (navigator.onLine) {
                        try {
                            await deleteDoc(doc(firestore, 'Osras', targetClassKey, 'children', localIdStr));
                        } catch (_) {}
                    }
                    await safePurgeLocalChild(localChild.id);
                    purged++;
                    localPurged++;
                    continue;
                }
            }
        }

        // b. If local record is not in this class's cloud snapshot and wasn't just pushed:
        const isInCloud = cloudDocIds.has(localIdStr);
        const wasJustPushed = pushedChildrenIds.has(localChild.id) || pushedChildrenIds.has(localIdStr);

        if (!isInCloud && !wasJustPushed) {
            // Check if the child was moved to another class in multi-class sync
            if (authoritativeClassByChildId && authoritativeClassByChildId.has(localIdStr)) {
                const newClass = authoritativeClassByChildId.get(localIdStr);
                if (newClass && newClass !== targetClassKey) {
                    await db.children.update(localChild.id, {
                        syncKey: newClass,
                        isDirty: false
                    });
                    continue;
                }
            }

            // Soft-delete locally (preserving the record in Dexie for the Recovery Center instead of hard-destroying it!)
            await db.children.update(localChild.id, {
                isDeleted: true,
                deletedAt: now,
                deletedBy: 'حذف سحابي سابق (تلقائي)',
                isDirty: false
            });
            purged++;
            localPurged++;
        }
    }

    if (localPurged > 0) {
        console.log(`🧹 [Reconciliation] Marked ${localPurged} ghost/strict-duplicate local records in ${targetClassKey}`);
    }

    return { added, updated, purged };
}

/**
 * Helper to push a single dirty child record to its strict `child.syncKey` in Firestore,
 * handling atomic class moves (`oldSyncKey -> newSyncKey`) and soft-delete tombstones (`isDeleted: true`).
 *
 * @param {Object} child - Local child record from `db.children`
 * @param {string} fallbackSyncKey - Used ONLY if `child.syncKey` is completely empty
 * @returns {Promise<{ pushed: boolean, cleanId: string, targetKey: string }>}
 */
async function pushSingleDirtyChildToCloud(child, fallbackSyncKey = '') {
    const now = Date.now();
    const rawSyncKey = child.syncKey || fallbackSyncKey;
    const targetKey = normalizeToValidSyncKey(rawSyncKey, null, fallbackSyncKey);

    if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') {
        return { pushed: false, cleanId: String(child.id), targetKey: '' };
    }

    const cleanId = String(ensureCleanChildId(child.id, child.gender));
    const docRef = doc(firestore, 'Osras', targetKey, 'children', cleanId);

    // Check existing cloud record to protect profilePic if local photo is empty
    let existingCloudData = null;
    try {
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            existingCloudData = processCloudDoc(snap);
        }
    } catch (_) {}

    const protectedPic = resolveProtectedProfilePic(child, existingCloudData);
    const updatedTimestamp = parseTimestampMs(child.updatedAt) || now;

    // 1. Handle Soft Deletion Tombstone (Part 4.2)
    if (child.isDeleted) {
        const tombstoneRecord = {
            ...(existingCloudData || {}),
            ...child,
            id: cleanId,
            syncKey: targetKey,
            profilePic: protectedPic,
            isDeleted: true,
            deletedAt: child.deletedAt || updatedTimestamp,
            deletedBy: child.deletedBy || getCurrentServantModificationName(),
            updatedAt: updatedTimestamp,
            isDirty: false
        };
        const { _rawId, _docId, _collectionSyncKey, ...cleanTombstone } = tombstoneRecord;
        await setDoc(docRef, buildCloudChildDocument(cleanTombstone), { merge: true });
        await db.children.put(cleanTombstone);
        return { pushed: true, cleanId, targetKey };
    }

    // 2. Handle Atomic Move from `oldSyncKey` to `targetKey` (Part 2.2)
    const oldSyncKey = child.oldSyncKey ? normalizeToValidSyncKey(child.oldSyncKey) : '';
    if (oldSyncKey && oldSyncKey !== targetKey && oldSyncKey !== 'MASTER_ACCESS' && oldSyncKey !== 'ADMIN_MODE' && oldSyncKey !== 'STAGE_ADMIN') {
        try {
            const oldDocRef = doc(firestore, 'Osras', oldSyncKey, 'children', cleanId);
            const oldTombstone = {
                ...child,
                id: cleanId,
                syncKey: oldSyncKey,
                profilePic: protectedPic,
                isDeleted: true,
                movedTo: targetKey,
                deletedAt: updatedTimestamp,
                deletedBy: 'نقل إلى فصل آخر',
                updatedAt: updatedTimestamp,
                isDirty: false
            };
            const { _rawId, _docId, _collectionSyncKey, oldSyncKey: _o, ...cleanOldTombstone } = oldTombstone;
            await setDoc(oldDocRef, buildCloudChildDocument(cleanOldTombstone), { merge: true });
        } catch (moveErr) {
            console.warn(`⚠️ Failed to write move tombstone in old class ${oldSyncKey}:`, moveErr?.message);
        }
    }

    // 3. Push Active Child Record strictly to `Osras/${targetKey}/children/${cleanId}`
    const activeRecord = {
        ...(existingCloudData || {}),
        ...child,
        id: cleanId,
        syncKey: targetKey,
        oldSyncKey: null,
        movedTo: null,
        profilePic: protectedPic,
        isDirty: false,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        updatedAt: updatedTimestamp
    };
    const { _rawId, _docId, _collectionSyncKey, ...cleanActive } = activeRecord;

    await setDoc(docRef, buildCloudChildDocument(cleanActive), { merge: true });

    if (cleanId !== String(child.id)) {
        try {
            await deleteDoc(doc(firestore, 'Osras', targetKey, 'children', String(child.id)));
        } catch (_) {}
        await db.children.delete(child.id);
    }
    await db.children.put(cleanActive);

    return { pushed: true, cleanId, targetKey };
}

/**
 * 🔄 Atomically moves a child from `oldSyncKey` to `newSyncKey`:
 * - Writes the child to `Osras/${newSyncKey}/children/${docId}` with `syncKey: newSyncKey, updatedAt: Date.now()`
 * - Marks the old document in `Osras/${oldSyncKey}/children/${docId}` with `isDeleted: true, movedTo: newSyncKey, updatedAt: Date.now()`
 * - Updates local `db.children`, `db.attendance`, and `db.grades` immediately.
 *
 * @param {string} childId
 * @param {string} newSyncKey
 * @param {Object} [extraUpdates]
 * @param {string} [servantName]
 * @returns {Promise<Object|null>} Updated child record
 */
export async function moveChildBetweenClasses(childId, newSyncKey, extraUpdates = {}, servantName = '') {
    if (!childId || !newSyncKey) return null;
    const existing = await db.children.get(String(childId));
    if (!existing) return null;

    const targetSyncKey = normalizeToValidSyncKey(newSyncKey, null, newSyncKey);
    const oldSyncKey = normalizeToValidSyncKey(existing.syncKey, null, existing.syncKey || '');
    const now = Date.now();
    const modifier = servantName || getCurrentServantModificationName();
    const cleanId = String(ensureCleanChildId(existing.id, extraUpdates.gender || existing.gender));

    const protectedPic = resolveProtectedProfilePic(extraUpdates, existing);

    const updatedChild = {
        ...existing,
        ...extraUpdates,
        id: cleanId,
        syncKey: targetSyncKey,
        oldSyncKey: oldSyncKey && oldSyncKey !== targetSyncKey ? oldSyncKey : null,
        movedTo: null,
        profilePic: protectedPic,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        lastModifiedBy: modifier,
        updatedAt: now,
        isDirty: true
    };

    await db.children.put(updatedChild);

    // Update local attendance & grades syncKey
    try {
        const localAtt = await db.attendance.where('childId').equals(cleanId).toArray();
        for (const att of localAtt) {
            await db.attendance.update(att.id, { syncKey: targetSyncKey, isDirty: true, updatedAt: now });
        }
        const localGrades = await db.grades.where('childId').equals(cleanId).toArray();
        for (const grd of localGrades) {
            await db.grades.update(grd.id, { syncKey: targetSyncKey, isDirty: true, updatedAt: now });
        }
    } catch (_) {}

    if (navigator.onLine) {
        try {
            await pushSingleDirtyChildToCloud(updatedChild, targetSyncKey);

            // Migrate attendance docs in Firestore from oldSyncKey to targetSyncKey
            if (oldSyncKey && oldSyncKey !== targetSyncKey) {
                const oldAttCol = collection(firestore, 'Osras', oldSyncKey, 'attendance');
                const oldAttSnap = await getDocs(oldAttCol);
                for (const aDoc of (oldAttSnap.docs || [])) {
                    if (aDoc.id === '_placeholder') continue;
                    const rawAtt = aDoc.data();
                    const attData = rawAtt?.payload ? decryptData(rawAtt.payload) : rawAtt;
                    if (attData && String(attData.childId) === cleanId) {
                        const newAttRef = doc(firestore, 'Osras', targetSyncKey, 'attendance', aDoc.id);
                        const updatedAtt = { ...attData, syncKey: targetSyncKey, updatedAt: now, isDirty: false };
                        await setDoc(newAttRef, { payload: encryptData(cleanData(updatedAtt)) }, { merge: true });
                        try { await deleteDoc(aDoc.ref); } catch (_) {}
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ [moveChildBetweenClasses] Offline or push deferred:', err?.message);
        }
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    return updatedChild;
}

/**
 * 🗑️ Deterministic Soft-Delete with immediate cloud tombstone propagation (Part 4.2):
 * Sets `isDeleted: true, deletedAt: Date.now(), deletedBy: currentServantName, updatedAt: Date.now(), isDirty: true`
 * and immediately pushes to `Osras/${child.syncKey}/children/${docId}` in Firestore.
 *
 * @param {string} childId
 * @param {string} [servantName]
 * @returns {Promise<boolean>}
 */
export async function softDeleteChildWithSync(childId, servantName = '') {
    if (!childId) return false;
    const existing = await db.children.get(String(childId));
    if (!existing) return false;

    const now = Date.now();
    const modifier = servantName || getCurrentServantModificationName();
    const targetSyncKey = normalizeToValidSyncKey(
        existing.syncKey,
        null,
        typeof localStorage !== 'undefined' ? localStorage.getItem('currentSyncKey') || '' : ''
    );

    const tombstoneLocal = {
        ...existing,
        syncKey: targetSyncKey || existing.syncKey,
        isDeleted: true,
        deletedAt: now,
        deletedBy: modifier,
        lastModifiedBy: modifier,
        updatedAt: now,
        isDirty: true
    };

    await db.children.put(tombstoneLocal);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    if (navigator.onLine && tombstoneLocal.syncKey) {
        try {
            await pushSingleDirtyChildToCloud(tombstoneLocal, tombstoneLocal.syncKey);
        } catch (err) {
            console.warn('⚠️ [softDeleteChildWithSync] Immediate cloud push deferred:', err?.message);
        }
    }

    return true;
}

/**
 * ✏️ Deterministic Edit helper with photo protection and immediate cloud push (Part 4.1):
 * Stamps `updatedAt: Date.now(), lastModifiedBy: currentServantName, isDirty: true`,
 * protects `profilePic`, handles class moves if `syncKey` changed, and immediately syncs to Firestore.
 *
 * @param {string} childId
 * @param {Object} updatedFields
 * @param {string} [servantName]
 * @returns {Promise<Object|null>}
 */
export async function saveAndSyncChildEdit(childId, updatedFields = {}, servantName = '') {
    if (!childId) return null;
    const existing = await db.children.get(String(childId));
    if (!existing) return null;

    const now = Date.now();
    const modifier = servantName || getCurrentServantModificationName();

    const oldSyncKey = normalizeToValidSyncKey(existing.syncKey, null, existing.syncKey || '');
    const requestedSyncKey = updatedFields.syncKey
        ? normalizeToValidSyncKey(updatedFields.syncKey, null, updatedFields.syncKey)
        : oldSyncKey;

    if (requestedSyncKey && oldSyncKey && requestedSyncKey !== oldSyncKey) {
        return await moveChildBetweenClasses(childId, requestedSyncKey, updatedFields, modifier);
    }

    const protectedPic = resolveProtectedProfilePic(updatedFields, existing);
    const updatedRecord = {
        ...existing,
        ...updatedFields,
        id: String(existing.id),
        syncKey: requestedSyncKey || existing.syncKey,
        profilePic: protectedPic,
        isDeleted: false,
        lastModifiedBy: modifier,
        updatedAt: now,
        isDirty: true
    };

    await db.children.put(updatedRecord);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    if (navigator.onLine && updatedRecord.syncKey) {
        try {
            await pushSingleDirtyChildToCloud(updatedRecord, updatedRecord.syncKey);
        } catch (err) {
            console.warn('⚠️ [saveAndSyncChildEdit] Immediate push deferred:', err?.message);
        }
    }

    return updatedRecord;
}

const _performReconcileAllClassesWithCloud = async (osrasList = []) => {
    try {
        console.log(`🔄 [Global Reconciliation] Starting reconciliation across ${osrasList.length} classes...`);
        const pushedIds = new Set();

        // 1. Push any pending dirty records first strictly to their own `child.syncKey`
        const dirtyKids = await db.children.filter(c => c.isDirty).toArray();
        for (const child of dirtyKids) {
            try {
                const res = await pushSingleDirtyChildToCloud(child, child.syncKey || '');
                if (res.pushed) {
                    pushedIds.add(res.cleanId);
                    pushedIds.add(String(child.id));
                }
            } catch (err) {
                console.warn(`Failed to push dirty child ${child.id}:`, err?.message);
            }
        }

        // 2. Fetch all classes from Firestore and resolve cross-class duplicates deterministically FIRST
        let totalPurged = 0;
        const validSyncKeys = new Set();
        const classDocsBySyncKey = new Map();

        for (const osra of osrasList) {
            const syncKey = osra?.syncKey;
            if (!syncKey || syncKey === 'MASTER_ACCESS' || syncKey === 'ADMIN_MODE' || syncKey === 'STAGE_ADMIN') continue;
            const cleanKey = String(syncKey).trim();
            validSyncKeys.add(cleanKey);

            try {
                const colRef = collection(firestore, 'Osras', cleanKey, 'children');
                const snap = await getDocs(colRef);
                const cloudDocs = (snap.docs || [])
                    .map(processCloudDoc)
                    .filter(Boolean);
                classDocsBySyncKey.set(cleanKey, cloudDocs);
            } catch (classErr) {
                console.warn(`⚠️ [Reconciliation] Error fetching cloud children for ${cleanKey}:`, classErr?.message);
            }
        }

        // Deterministically resolve cross-class duplicates (Part 2.3)
        const {
            resolvedClassDocsMap,
            authoritativeClassByChildId,
            crossClassResolvedCount
        } = await resolveCrossClassDuplicatesAcrossCloud(classDocsBySyncKey);
        totalPurged += crossClassResolvedCount;

        // 3. Reconcile each class using the cross-class deduplicated map
        for (const [syncKey, cloudDocs] of resolvedClassDocsMap.entries()) {
            try {
                const result = await reconcileClassChildren(syncKey, cloudDocs, pushedIds, authoritativeClassByChildId);
                totalPurged += result.purged;
            } catch (recErr) {
                console.warn(`⚠️ [Reconciliation] Error reconciling ${syncKey}:`, recErr?.message);
            }
        }

        // 4. Normalize any local children whose syncKey was stored as an Arabic class name instead of syncKey code
        if (validSyncKeys.size > 0) {
            const allLocal = await db.children.toArray();
            for (const c of allLocal) {
                if (c.isDeleted) continue;
                const currentKey = String(c.syncKey || '').trim();
                if (!validSyncKeys.has(currentKey)) {
                    const normalizedKey = normalizeToValidSyncKey(currentKey);
                    if (normalizedKey && validSyncKeys.has(normalizedKey)) {
                        await db.children.update(c.id, {
                            syncKey: normalizedKey,
                            isDirty: true,
                            updatedAt: Date.now()
                        });
                    }
                }
            }
        }

        console.log(`✅ [Global Reconciliation] Finished. Resolved ${totalPurged} stale/duplicate records.`);
        return { success: true, totalPurged };
    } catch (err) {
        console.error('❌ [Global Reconciliation] Error:', err);
        return { success: false, error: err.message };
    }
};

/**
 * 👑 Reconciles the local Dexie database across all registered classes (Osras).
 * Called by MasterDashboard and syncDataWithCloud when running full admin sync.
 * Guarded by activeReconcilePromise mutex.
 * 
 * @param {Array<object>} osrasList - List of Osra objects with syncKey
 * @returns {Promise<{ success: boolean, totalPurged: number }>}
 */
export async function reconcileAllClassesWithCloud(osrasList = []) {
    if (!navigator.onLine) return { success: false, totalPurged: 0 };

    if (activeReconcilePromise) {
        console.log("ℹ️ [Reconciliation] Global reconciliation already in progress, awaiting existing promise...");
        return activeReconcilePromise;
    }

    activeReconcilePromise = (async () => {
        try {
            return await _performReconcileAllClassesWithCloud(osrasList);
        } finally {
            activeReconcilePromise = null;
        }
    })();

    return activeReconcilePromise;
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
            settingsSnap = await getDocFromServer(settingsRef);
        } catch (e) {
            settingsSnap = await getDoc(settingsRef);
        }
        
        let activeOsrasList = [];

        if (settingsSnap.exists()) {
            const cloudSettings = settingsSnap.data();
            activeOsrasList = getAllConfiguredOsras(cloudSettings);
            if (activeOsrasList.length === 0) {
                activeOsrasList = (cloudSettings.services || []).flatMap(s => s.osras || []).filter(o => o.syncKey);
            }
            
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
        // CRITICAL (Part 2.2): Every child MUST be pushed strictly to `Osras/${child.syncKey}/children/${docId}`.
        // NEVER push a child to the caller's `currentSyncKey` if `child.syncKey` is different!

        // 1a. رفع الأطفال
        try {
            const fallbackSingleClassKey = (currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE' && currentSyncKey !== 'STAGE_ADMIN')
                ? currentSyncKey
                : '';

            for (const child of localChildren) {
                if (!child.isDirty) continue;

                const res = await pushSingleDirtyChildToCloud(child, fallbackSingleClassKey);
                if (!res.pushed) continue;

                if (child.isDeleted) {
                    pushLog.children.push(`🗑️${(child.name || '').split(' ')[0]}`);
                } else {
                    pushLog.children.push((child.name || '').split(' ')[0]);
                }
                pushedChildrenIds.add(String(res.cleanId));
                pushedChildrenIds.add(String(child.id));
            }
        } catch (e) {
            console.error('Error syncing children push:', e);
        }

        // 1b. رفع الغياب (Strictly use record.syncKey first!)
        try {
            for (const record of localAttendance) {
                if (!record.isDirty) continue;

                const targetKey = record.syncKey || ((currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE' && currentSyncKey !== 'STAGE_ADMIN') ? currentSyncKey : '');
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

                let targetKey = event.syncKey || currentSyncKey;
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

                const targetKey = exam.syncKey || currentSyncKey;
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

                const targetKey = grade.syncKey || currentSyncKey;
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
        if (isAdmin && (currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE')) {
            if (activeOsrasList.length > 0) {
                classesToSync = activeOsrasList.map(o => o.syncKey).filter(Boolean);
            } else {
                const allConfigured = getAllConfiguredOsras();
                classesToSync = allConfigured.map(o => o.syncKey).filter(Boolean);
            }
        } else if (isStageAdmin && currentSyncKey === 'STAGE_ADMIN') {
            classesToSync = allowedClasses;
        } else {
            classesToSync = [currentSyncKey];
        }

        // 2b. سحب ومطابقة الأطفال لكل فصل بدقة (مع حل التضارب بين الفصول أولاً)
        const classDocsBySyncKey = new Map();
        for (const classKey of classesToSync) {
            if (!classKey || classKey === 'MASTER_ACCESS' || classKey === 'ADMIN_MODE' || classKey === 'STAGE_ADMIN') continue;
            try {
                const classChildrenCol = collection(firestore, 'Osras', classKey, 'children');
                const snap = await getDocs(classChildrenCol);
                const cloudDocs = (snap.docs || []).map(processCloudDoc).filter(Boolean);
                classDocsBySyncKey.set(String(classKey), cloudDocs);
            } catch (err) {
                console.warn(`Error pulling children for class ${classKey}:`, err?.message);
            }
        }

        // Resolve cross-class duplicates deterministically if syncing multiple classes
        let resolvedClassDocsMap = classDocsBySyncKey;
        let authoritativeClassByChildId = null;
        if (classDocsBySyncKey.size > 1) {
            const crossRes = await resolveCrossClassDuplicatesAcrossCloud(classDocsBySyncKey);
            resolvedClassDocsMap = crossRes.resolvedClassDocsMap;
            authoritativeClassByChildId = crossRes.authoritativeClassByChildId;
        }

        for (const [classKey, cloudDocs] of resolvedClassDocsMap.entries()) {
            try {
                const recResult = await reconcileClassChildren(classKey, cloudDocs, pushedChildrenIds, authoritativeClassByChildId);
                if (recResult.added > 0) pullLog.childrenAdded.push(`${classKey}(+${recResult.added})`);
                if (recResult.updated > 0) pullLog.childrenUpdated.push(`${classKey}(~${recResult.updated})`);
            } catch (err) {
                console.warn(`Error reconciling children for class ${classKey}:`, err?.message);
            }
        }

        // 2c. Normalize any local children whose syncKey was stored as an Arabic class name instead of syncKey code
        if (classesToSync.length > 0) {
            const validKeySet = new Set(classesToSync.map(String));
            const allLocal = await db.children.toArray();
            for (const c of allLocal) {
                if (c.isDeleted) continue;
                const sKey = String(c.syncKey || '').trim();
                if (!validKeySet.has(sKey)) {
                    const normKey = normalizeToValidSyncKey(sKey);
                    if (normKey && normKey !== sKey) {
                        await db.children.update(c.id, { syncKey: normKey, isDirty: true, updatedAt: Date.now() });
                    }
                }
            }
        }

        // 2d. سحب الغياب مع مطابقة صارمة ومنع التكرار (Attendance Pull & Strict Reconciliation)
        let cloudAttendance = [];
        if (isAdmin && (currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE')) {
            const attSnap = await getDocs(collectionGroup(firestore, 'attendance'));
            cloudAttendance = (attSnap?.docs || []).map(processCloudDoc).filter(Boolean);
        } else if (isStageAdmin && currentSyncKey === 'STAGE_ADMIN') {
            const attSnaps = await Promise.all(classesToSync.map(key => getDocs(collection(firestore, 'Osras', key, 'attendance'))));
            cloudAttendance = attSnaps.flatMap(snap => (snap?.docs || []).map(processCloudDoc)).filter(Boolean);
        } else {
            const attSnap = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'attendance'));
            cloudAttendance = (attSnap?.docs || []).map(processCloudDoc).filter(Boolean);
        }

        const cloudAttendanceKeys = new Set();
        const cloudAttByKey = new Map();
        for (const cAtt of cloudAttendance) {
            if (!cAtt.date || !cAtt.childId || !cAtt.type) continue;
            const compositeKey = `${cAtt.date}_${cAtt.childId}_${cAtt.type}`;
            cloudAttendanceKeys.add(compositeKey);
            const existing = cloudAttByKey.get(compositeKey);
            if (!existing || parseTimestampMs(cAtt.updatedAt) > parseTimestampMs(existing.updatedAt)) {
                cloudAttByKey.set(compositeKey, cAtt);
            }
        }

        const localAttList = await db.attendance.toArray();
        const localAttByKey = new Map();
        for (const la of localAttList) {
            const key = `${la.date}_${la.childId}_${la.type}`;
            if (!localAttByKey.has(key)) localAttByKey.set(key, []);
            localAttByKey.get(key).push(la);
        }

        // 🛡️ Phase 1: Deduplicate local attendance — only keep one record per composite key
        for (const [key, records] of localAttByKey.entries()) {
            if (records.length <= 1) continue;
            records.sort((a, b) => {
                if (a.isDeleted !== b.isDeleted) return a.isDeleted ? 1 : -1;
                return parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt);
            });
            for (let i = 1; i < records.length; i++) {
                try { await db.attendance.delete(records[i].id); } catch (_) {}
            }
            localAttByKey.set(key, [records[0]]);
        }

        // 🛡️ Phase 2: Pull cloud records not present locally, or update existing ones
        for (const [compositeKey, cAtt] of cloudAttByKey.entries()) {
            if (pushedAttendanceIds.has(compositeKey)) continue;

            const localMatches = localAttByKey.get(compositeKey);
            if (!localMatches || localMatches.length === 0) {
                const { id: _id, _rawId, _docId, _collectionSyncKey, ...dataToInsert } = cAtt;
                const syncKeyToSave = dataToInsert.syncKey || dataToInsert._collectionSyncKey || currentSyncKey;
                await db.attendance.add({ ...dataToInsert, syncKey: String(syncKeyToSave), isDirty: false, isDeleted: false, updatedAt: cAtt.updatedAt || now });
                pullLog.attendanceAdded.push(`${cAtt.childId}(${cAtt.date.slice(5)})`);
            } else {
                const local = localMatches[0];
                if (!local.isDirty && parseTimestampMs(cAtt.updatedAt) > parseTimestampMs(local.updatedAt)) {
                    const { _rawId, _docId, _collectionSyncKey, ...cleanAtt } = cAtt;
                    const syncKeyToSave = cleanAtt.syncKey || local.syncKey || currentSyncKey;
                    await db.attendance.update(local.id, { ...cleanAtt, id: local.id, syncKey: String(syncKeyToSave), isDirty: false, isDeleted: false, updatedAt: cAtt.updatedAt || now });
                }
            }
        }

        // 🛡️ Phase 3: Purge deleted local attendance records & cloud-deleted attendance
        const syncKeySet = new Set(classesToSync.map(String));
        for (const [key, records] of localAttByKey.entries()) {
            for (const rec of records) {
                if (rec.isDeleted) {
                    try { await db.attendance.delete(rec.id); } catch (_) {}
                    continue;
                }
                const recSyncKey = String(rec.syncKey || '');
                if (!rec.isDirty && !pushedAttendanceIds.has(key) && !cloudAttendanceKeys.has(key)) {
                    if (syncKeySet.has(recSyncKey) || recSyncKey === String(currentSyncKey)) {
                        try { await db.attendance.delete(rec.id); } catch (_) {}
                    }
                }
            }
        }

        // 2e. سحب الأحداث (Events Pull & Reconciliation)
        let cloudEvents = [];
        if (isAdmin && (currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE')) {
            const eventsSnapshot = await getDocs(collectionGroup(firestore, 'events'));
            cloudEvents = (eventsSnapshot?.docs || []).map(processCloudDoc).filter(Boolean);
        } else if (isStageAdmin && currentSyncKey === 'STAGE_ADMIN') {
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
        const cloudEventIds = new Set(cloudEvents.map(e => String(e.id)));

        for (const cloudEvent of cloudEvents) {
            if (pushedEventsIds.has(cloudEvent.id)) continue;

            const localMatch = localEventsMap.get(cloudEvent.id);
            let syncKeyToSave = cloudEvent.syncKey || cloudEvent._collectionSyncKey || currentSyncKey;
            if (cloudEvent.isGlobal || cloudEvent.syncKey === 'global') syncKeyToSave = 'global';

            const { _rawId, _docId, _collectionSyncKey, ...cleanEvent } = cloudEvent;
            const eventToSave = { ...cleanEvent, syncKey: String(syncKeyToSave), isDirty: false, isDeleted: false, updatedAt: cloudEvent.updatedAt || now };

            if (!eventToSave.id) continue;

            if (!localMatch) {
                pullLog.eventsAdded.push(cloudEvent.title || 'حدث');
                await db.events.put(eventToSave);
            } else {
                if (parseTimestampMs(cloudEvent.updatedAt) > parseTimestampMs(lastSyncTime) && !localMatch.isDirty) {
                    pullLog.eventsUpdated.push(cloudEvent.title || 'حدث');
                    await db.events.put(eventToSave);
                }
            }
        }

        for (const localEvent of localEvList) {
            if (!localEvent.isDirty && !pushedEventsIds.has(localEvent.id) && !cloudEventIds.has(String(localEvent.id))) {
                const evSyncKey = String(localEvent.syncKey || '');
                if (syncKeySet.has(evSyncKey) || evSyncKey === 'global' || evSyncKey === String(currentSyncKey)) {
                    try { await db.events.delete(localEvent.id); } catch (_) {}
                }
            }
        }

        // 2f. سحب ومطابقة الامتحانات والدرجات (Exams & Grades Pull & Reconciliation)
        let cloudExamsList = [];
        if (isAdmin && (currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE')) {
            const examsSnapshot = await getDocs(collectionGroup(firestore, 'exams'));
            cloudExamsList = (examsSnapshot?.docs || [])
                .filter(d => d.ref.parent.id === 'exams' && d.id !== '_placeholder' && !d.data().placeholder)
                .map(d => ({ firebaseId: d.id, ...d.data() }))
                .filter(Boolean);
        } else if (isStageAdmin && currentSyncKey === 'STAGE_ADMIN') {
            const examsSnaps = await Promise.all(classesToSync.map(key => getDocs(collection(firestore, 'Osras', key, 'exams'))));
            cloudExamsList = examsSnaps.flatMap(snap => (snap?.docs || []).filter(d => d.id !== '_placeholder' && !d.data().placeholder).map(d => ({ firebaseId: d.id, ...d.data() }))).filter(Boolean);
        } else {
            const examsSnapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'exams'));
            cloudExamsList = (examsSnapshot?.docs || []).filter(d => d.id !== '_placeholder' && !d.data().placeholder).map(d => ({ firebaseId: d.id, ...d.data() })).filter(Boolean);
        }

        const freshLocalExams = await db.exams.toArray();
        const localExamsMap = new Map(freshLocalExams.map(e => [e.firebaseId, e]));
        const cloudExamFirebaseIds = new Set(cloudExamsList.map(e => String(e.firebaseId)));

        const freshLocalGrades = await db.grades.toArray();
        const localGradesMap = new Map();
        for (const g of freshLocalGrades) {
            localGradesMap.set(`${g.examId}_${String(g.childId)}`, g);
        }

        for (const cloudExam of cloudExamsList) {
            if (pushedExamIds.has(cloudExam.firebaseId)) continue;

            const localMatch = localExamsMap.get(cloudExam.firebaseId);
            const syncKeyToSave = cloudExam.syncKey || currentSyncKey;
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
                if (parseTimestampMs(cloudExam.updatedAt) > parseTimestampMs(lastSyncTime) && !localMatch.isDirty) {
                    pullLog.examsUpdated.push(cloudExam.examName);
                    await db.exams.update(localMatch.id, examToSave);
                }
            }

            try {
                const gradesColRef = collection(firestore, 'Osras', String(syncKeyToSave), 'exams', cloudExam.firebaseId, 'grades');
                const gradesSnapshot = await getDocs(gradesColRef);
                const cloudChildIdsForExam = new Set();

                for (const gradeDoc of (gradesSnapshot?.docs || [])) {
                    if (gradeDoc.id === '_placeholder') continue;
                    const rawData = gradeDoc.data();
                    if (rawData.placeholder || rawData.isPlaceholder) continue;
                    const gradeData = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!gradeData || !gradeData.childId) continue;

                    const cleanChildId = String(gradeData.childId);
                    cloudChildIdsForExam.add(cleanChildId);

                    const gradeKey = `${cloudExam.firebaseId}_${cleanChildId}`;
                    if (pushedGradeKeys.has(gradeKey)) continue;

                    const localGradeMatch = localGradesMap.get(gradeKey);

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
                        pullLog.gradesAdded.push(`${cloudExam.examName}/${cleanChildId}`);
                        const newId = await db.grades.add(gradeToSave);
                        localGradesMap.set(gradeKey, { ...gradeToSave, id: newId });
                    } else {
                        if (parseTimestampMs(gradeData.updatedAt) > parseTimestampMs(lastSyncTime) && !localGradeMatch.isDirty) {
                            pullLog.gradesUpdated.push(`${cloudExam.examName}/${cleanChildId}`);
                            await db.grades.update(localGradeMatch.id, gradeToSave);
                            localGradesMap.set(gradeKey, { ...gradeToSave, id: localGradeMatch.id });
                        }
                    }
                }

                for (const [key, localGrade] of localGradesMap.entries()) {
                    if (localGrade.examId === cloudExam.firebaseId && !localGrade.isDirty) {
                        const cleanChildId = String(localGrade.childId);
                        const gradeKey = `${cloudExam.firebaseId}_${cleanChildId}`;
                        if (!cloudChildIdsForExam.has(cleanChildId) && !pushedGradeKeys.has(gradeKey)) {
                            try {
                                await db.grades.delete(localGrade.id);
                                localGradesMap.delete(key);
                            } catch (_) {}
                        }
                    }
                }
            } catch (_e) { /* ignore */ }
        }

        for (const localExam of freshLocalExams) {
            if (!localExam.isDirty && !pushedExamIds.has(localExam.firebaseId) && !cloudExamFirebaseIds.has(String(localExam.firebaseId))) {
                const exSyncKey = String(localExam.syncKey || '');
                if (syncKeySet.has(exSyncKey) || exSyncKey === String(currentSyncKey)) {
                    try {
                        await db.exams.delete(localExam.id);
                        await db.grades.where('examId').equals(localExam.firebaseId).delete();
                    } catch (_) {}
                }
            }
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

const _performSyncDataWithCloud = async (retryCount = 0) => {
    if (!navigator.onLine) {
        return { success: false, message: "⚠️ لا يوجد اتصال بالإنترنت. يرجى المحاولة لاحقاً." };
    }

    if (retryCount === 0) {
        window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'syncing' } }));
    }

    try {
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
                return await _performSyncDataWithCloud(retryCount + 1);
            }
            window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'error' } }));
            return { success: false, message: "⏱️ انتهت مهلة الاتصال بالإنترنت أثناء الرفع. الرجاء التأكد من استقرار الشبكة." };
        }
        window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'error' } }));
        return { success: false, message: `حصلت مشكلة: ${error.message}` };
    }
};

/**
 * Global synchronized cloud push & pull.
 * Guarded by activeSyncPromise singleton to prevent concurrent overlapping sync cycles.
 */
export const syncDataWithCloud = async (retryCount = 0) => {
    if (!navigator.onLine) {
        return { success: false, message: "⚠️ لا يوجد اتصال بالإنترنت. يرجى المحاولة لاحقاً." };
    }

    if (activeSyncPromise) {
        console.log("ℹ️ [Sync] Sync already in progress, awaiting active sync promise...");
        return activeSyncPromise;
    }

    activeSyncPromise = (async () => {
        try {
            return await _performSyncDataWithCloud(retryCount);
        } finally {
            activeSyncPromise = null;
        }
    })();

    return activeSyncPromise;
};

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ PART 5: DATA AUDIT & RECOVERY CENTER (فحص واستعادة بيانات الفصول والصور)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scans all Firestore `Osras/{syncKey}/children` collections + local `db.children`
 * to build a complete diagnostic report for the MasterDashboard Recovery Center:
 * 1. Cross-Class Conflicts (تقرير الأطفال المتكررين بين فصلين)
 * 2. Deleted / Missing Children Recovery (استعادة الأطفال المخفيين أو المحذوفين بالخطأ)
 * 3. Photo Recovery (استعادة الصور المفقودة)
 *
 * @param {Array<object>} [osrasListInput]
 * @param {Object|null} [appSettingsInput]
 * @returns {Promise<Object>}
 */
export async function scanDataIntegrityAndRecovery(osrasListInput = [], appSettingsInput = null) {
    const allOsras = osrasListInput && osrasListInput.length > 0
        ? osrasListInput
        : getAllConfiguredOsras(appSettingsInput);

    const validSyncKeySet = new Set(allOsras.map(o => String(o.syncKey).trim()).filter(Boolean));
    const localChildren = (await db.children.toArray()) || [];
    const localById = new Map(localChildren.map(c => [String(c.id), c]));

    // Map of childId -> Array of cloud copies across classes
    const cloudCopiesById = new Map();
    // Photo bank: maps childId or normalized 4-part name to any valid profilePic found across snapshots
    const photoBankById = new Map();
    const photoBankByName = new Map();

    const registerPhotoCandidate = (id, name, pic, sourceDesc) => {
        if (!isValidProfilePic(pic)) return;
        const cleanPic = pic.trim();
        if (id && !photoBankById.has(String(id))) {
            photoBankById.set(String(id), { profilePic: cleanPic, sourceDescription: sourceDesc });
        }
        const normName = normalizeArabicName(name);
        if (normName && normName.split(' ').filter(Boolean).length >= 3 && !photoBankByName.has(normName)) {
            photoBankByName.set(normName, { profilePic: cleanPic, sourceDescription: sourceDesc });
        }
    };

    // Register local photos into photo bank first
    for (const lc of localChildren) {
        const classInfo = resolveChildClassInfo(lc.syncKey, appSettingsInput);
        registerPhotoCandidate(lc.id, lc.name, lc.profilePic, `النسخة المحلية (${classInfo.osraName})`);
    }

    // Scan Firestore across all configured classes if online
    if (navigator.onLine) {
        await Promise.all(allOsras.map(async (osra) => {
            const sKey = String(osra.syncKey || '').trim();
            if (!sKey || sKey === 'MASTER_ACCESS' || sKey === 'ADMIN_MODE' || sKey === 'STAGE_ADMIN') return;
            try {
                const snap = await getDocs(collection(firestore, 'Osras', sKey, 'children'));
                for (const d of (snap.docs || [])) {
                    const data = processCloudDoc(d);
                    if (!data) continue;
                    const cleanId = String(ensureCleanChildId(data.id, data.gender));
                    const classInfo = resolveChildClassInfo(sKey, appSettingsInput);

                    registerPhotoCandidate(
                        cleanId,
                        data.name,
                        data.profilePic,
                        `سحابة فصل (${classInfo.osraName})`
                    );

                    if (!cloudCopiesById.has(cleanId)) {
                        cloudCopiesById.set(cleanId, []);
                    }
                    cloudCopiesById.get(cleanId).push({
                        childId: cleanId,
                        rawDocId: d.id,
                        syncKey: sKey,
                        osraName: classInfo.osraName,
                        serviceName: classInfo.serviceName,
                        isDeleted: Boolean(data.isDeleted),
                        movedTo: data.movedTo || null,
                        deletedAt: data.deletedAt || null,
                        deletedBy: data.deletedBy || '',
                        lastModifiedBy: data.lastModifiedBy || '',
                        updatedAt: data.updatedAt || null,
                        updatedAtMs: parseTimestampMs(data.updatedAt),
                        profilePic: isValidProfilePic(data.profilePic) ? data.profilePic.trim() : '',
                        childData: { ...data, id: cleanId, syncKey: sKey }
                    });
                }
            } catch (err) {
                console.warn(`⚠️ [Audit Scan] Error scanning Osras/${sKey}/children:`, err?.message);
            }
        }));
    }

    // 1. Build Cross-Class Conflicts Report
    const crossClassConflicts = [];
    const activeClassByChildId = new Map();

    for (const [childId, copies] of cloudCopiesById.entries()) {
        // Distinct classes where this child exists in Firestore
        const activeCopies = copies.filter(c => !c.isDeleted);
        const distinctClasses = new Set(copies.map(c => c.syncKey));

        // Sort copies so newest active is first
        const sortedCopies = [...copies].sort((a, b) => {
            if (a.isDeleted !== b.isDeleted) return a.isDeleted ? 1 : -1;
            return b.updatedAtMs - a.updatedAtMs;
        });

        if (activeCopies.length > 0) {
            activeClassByChildId.set(childId, sortedCopies[0].syncKey);
        }

        // Report conflict if child is active in >1 class, OR exists in multiple classes where active copy conflicts with local syncKey
        const localRec = localById.get(childId);
        const hasLocalClassMismatch = localRec && !localRec.isDeleted && activeCopies.length === 1 && localRec.syncKey && localRec.syncKey !== activeCopies[0].syncKey;

        if (activeCopies.length > 1 || (distinctClasses.size > 1 && activeCopies.length >= 1 && copies.some(c => !c.isDeleted && c.movedTo)) || hasLocalClassMismatch) {
            const bestCopy = sortedCopies[0];
            const bestPic = photoBankById.get(childId)?.profilePic || bestCopy.profilePic || '';
            crossClassConflicts.push({
                childId,
                name: bestCopy.childData?.name || localRec?.name || childId,
                phone: bestCopy.childData?.fatherPhone || bestCopy.childData?.phone || localRec?.fatherPhone || localRec?.phone || '',
                profilePic: bestPic,
                recommendedSyncKey: bestCopy.syncKey,
                recommendedOsraName: bestCopy.osraName,
                localSyncKey: localRec?.syncKey || '',
                localOsraName: localRec?.syncKey ? resolveChildClassInfo(localRec.syncKey, appSettingsInput).osraName : '',
                copies: sortedCopies
            });
        }
    }

    // 2. Build Deleted / Missing Children Recovery List
    const deletedOrMissingChildren = [];
    const seenDeletedIds = new Set();

    // Check cloud deleted records (excluding move-tombstones where the child is already active in another class!)
    for (const [childId, copies] of cloudCopiesById.entries()) {
        if (activeClassByChildId.has(childId)) continue; // Already active in a valid class

        const sorted = [...copies].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        const latest = sorted[0];
        if (!latest) continue;

        const isValidKey = validSyncKeySet.has(latest.syncKey);
        if (latest.isDeleted || !isValidKey) {
            const isAccidental = isSystemOrAccidentalDelete(latest.childData) || !isValidKey;
            const bestPic = photoBankById.get(childId)?.profilePic || latest.profilePic || '';
            seenDeletedIds.add(childId);
            deletedOrMissingChildren.push({
                childId,
                name: latest.childData?.name || childId,
                phone: latest.childData?.fatherPhone || latest.childData?.motherPhone || latest.childData?.phone || '',
                syncKey: isValidKey ? latest.syncKey : normalizeToValidSyncKey(latest.syncKey, appSettingsInput),
                rawSyncKey: latest.syncKey,
                osraName: latest.osraName,
                isValidSyncKey: isValidKey,
                isDeleted: Boolean(latest.isDeleted),
                deletedAt: latest.deletedAt || latest.updatedAt,
                deletedBy: latest.deletedBy || (isValidKey ? 'غير مسجل (حذف تلقائي)' : 'فصل غير معروف'),
                isAccidentalPurge: isAccidental,
                profilePic: bestPic,
                source: localById.has(childId) ? 'both' : 'cloud',
                childData: { ...latest.childData, profilePic: bestPic }
            });
        }
    }

    // Check local Dexie for any deleted or missing-syncKey children not already in seenDeletedIds
    for (const lc of localChildren) {
        const childId = String(lc.id);
        if (seenDeletedIds.has(childId)) continue;
        if (activeClassByChildId.has(childId) && !lc.isDeleted && validSyncKeySet.has(String(lc.syncKey || ''))) continue;

        const sKey = String(lc.syncKey || '').trim();
        const isValidKey = validSyncKeySet.has(sKey);

        if (lc.isDeleted || !isValidKey) {
            const classInfo = resolveChildClassInfo(sKey, appSettingsInput);
            const normalizedKey = normalizeToValidSyncKey(sKey, appSettingsInput);
            const isAccidental = isSystemOrAccidentalDelete(lc) || !isValidKey;
            const bestPic = photoBankById.get(childId)?.profilePic || (isValidProfilePic(lc.profilePic) ? lc.profilePic.trim() : '');
            seenDeletedIds.add(childId);
            deletedOrMissingChildren.push({
                childId,
                name: lc.name || childId,
                phone: lc.fatherPhone || lc.motherPhone || lc.phone || '',
                syncKey: validSyncKeySet.has(normalizedKey) ? normalizedKey : (allOsras[0]?.syncKey || sKey),
                rawSyncKey: sKey,
                osraName: classInfo.osraName,
                isValidSyncKey: isValidKey,
                isDeleted: Boolean(lc.isDeleted),
                deletedAt: lc.deletedAt || lc.updatedAt,
                deletedBy: lc.deletedBy || (isValidKey ? 'غير مسجل (حذف تلقائي)' : 'كود فصل غير مطابق'),
                isAccidentalPurge: isAccidental,
                profilePic: bestPic,
                source: 'local',
                childData: { ...lc, profilePic: bestPic }
            });
        }
    }

    // 3. Build Photo Recovery List (active children missing profilePic where a valid photo exists in another copy/snapshot)
    const missingPhotoRecoveries = [];
    const seenPhotoRecoveryIds = new Set();

    // Check active local and cloud records
    const allActiveCandidates = [];
    for (const lc of localChildren) {
        if (!lc.isDeleted) allActiveCandidates.push(lc);
    }
    for (const [childId, copies] of cloudCopiesById.entries()) {
        const activeCopy = copies.find(c => !c.isDeleted);
        if (activeCopy && !localById.has(childId)) {
            allActiveCandidates.push(activeCopy.childData);
        }
    }

    for (const activeChild of allActiveCandidates) {
        const childId = String(activeChild.id);
        if (seenPhotoRecoveryIds.has(childId)) continue;

        const hasActivePic = isValidProfilePic(activeChild.profilePic);
        // Also check if cloud copy is missing the photo that local has, or vice versa
        const cloudCopies = cloudCopiesById.get(childId) || [];
        const activeCloudCopy = cloudCopies.find(c => !c.isDeleted);
        const cloudMissingPic = activeCloudCopy && !isValidProfilePic(activeCloudCopy.profilePic);

        if (!hasActivePic || cloudMissingPic) {
            const byIdMatch = photoBankById.get(childId);
            const normName = normalizeArabicName(activeChild.name);
            const byNameMatch = normName ? photoBankByName.get(normName) : null;
            const match = byIdMatch || byNameMatch;

            if (match && isValidProfilePic(match.profilePic)) {
                seenPhotoRecoveryIds.add(childId);
                const classInfo = resolveChildClassInfo(activeChild.syncKey, appSettingsInput);
                missingPhotoRecoveries.push({
                    childId,
                    name: activeChild.name || childId,
                    syncKey: activeChild.syncKey || activeCloudCopy?.syncKey || '',
                    osraName: classInfo.osraName,
                    recoveredProfilePic: match.profilePic,
                    sourceDescription: match.sourceDescription,
                    childData: activeChild
                });
            }
        }
    }

    // Sort lists for clean presentation
    deletedOrMissingChildren.sort((a, b) => parseTimestampMs(b.deletedAt) - parseTimestampMs(a.deletedAt));

    return {
        crossClassConflicts,
        deletedOrMissingChildren,
        missingPhotoRecoveries,
        summary: {
            crossClassCount: crossClassConflicts.length,
            deletedOrOrphanCount: deletedOrMissingChildren.length,
            accidentalPurgeCount: deletedOrMissingChildren.filter(d => d.isAccidentalPurge).length,
            recoverablePhotosCount: missingPhotoRecoveries.length
        }
    };
}

/**
 * 1. Resolves a Cross-Class Conflict by locking the child into `chosenSyncKey`
 * and tombstoning/cleaning up all other class copies in Firestore and local Dexie.
 *
 * @param {Object} conflictItem
 * @param {string} chosenSyncKey
 * @returns {Promise<boolean>}
 */
export async function resolveCrossClassConflictChoice(conflictItem, chosenSyncKey) {
    if (!conflictItem || !chosenSyncKey) return false;
    const childId = String(conflictItem.childId);
    const targetSyncKey = String(chosenSyncKey).trim();
    const now = Date.now();
    const modifier = getCurrentServantModificationName();

    // Merge all copies to ensure no data or photo is lost
    let mergedData = {};
    for (const copy of [...(conflictItem.copies || [])].reverse()) {
        mergedData = mergeChildRecordsPreservingPhoto(copy.childData, mergedData);
    }
    const existingLocal = await db.children.get(childId);
    if (existingLocal) {
        mergedData = mergeChildRecordsPreservingPhoto(mergedData, existingLocal);
    }
    if (isValidProfilePic(conflictItem.profilePic)) {
        mergedData.profilePic = conflictItem.profilePic.trim();
    }

    const activeRecord = {
        ...mergedData,
        id: childId,
        syncKey: targetSyncKey,
        oldSyncKey: null,
        movedTo: null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        lastModifiedBy: modifier,
        updatedAt: now,
        isDirty: false
    };

    const { _rawId, _docId, _collectionSyncKey, ...cleanActive } = activeRecord;
    await db.children.put(cleanActive);

    // Update local attendance & grades to chosenSyncKey
    try {
        const localAtt = await db.attendance.where('childId').equals(childId).toArray();
        for (const att of localAtt) {
            await db.attendance.update(att.id, { syncKey: targetSyncKey, updatedAt: now });
        }
    } catch (_) {}

    if (navigator.onLine) {
        // Write authoritative active record to chosen class
        await setDoc(
            doc(firestore, 'Osras', targetSyncKey, 'children', childId),
            buildCloudChildDocument(cleanActive),
            { merge: true }
        );

        // Tombstone all other classes where this child appeared
        for (const copy of (conflictItem.copies || [])) {
            if (copy.syncKey === targetSyncKey) continue;
            try {
                const tombstone = {
                    ...cleanActive,
                    syncKey: copy.syncKey,
                    isDeleted: true,
                    movedTo: targetSyncKey,
                    deletedAt: now,
                    deletedBy: 'نقل وتوحيد فصل المخدوم',
                    updatedAt: now
                };
                await setDoc(
                    doc(firestore, 'Osras', copy.syncKey, 'children', childId),
                    buildCloudChildDocument(tombstone),
                    { merge: true }
                );
            } catch (err) {
                console.warn(`⚠️ Failed to tombstone copy in ${copy.syncKey}:`, err?.message);
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    return true;
}

/**
 * 2. Restores a deleted or missing-`syncKey` child back to `targetSyncKey` (1-click "استعادة للفصل").
 *
 * @param {Object} recoveryItem
 * @param {string} [targetSyncKeyOverride]
 * @returns {Promise<boolean>}
 */
export async function restoreDeletedOrOrphanChild(recoveryItem, targetSyncKeyOverride = '') {
    if (!recoveryItem) return false;
    const childId = String(recoveryItem.childId);
    const targetKey = normalizeToValidSyncKey(
        targetSyncKeyOverride || recoveryItem.syncKey || recoveryItem.rawSyncKey
    );
    if (!targetKey || targetKey === 'MASTER_ACCESS' || targetKey === 'ADMIN_MODE' || targetKey === 'STAGE_ADMIN') {
        return false;
    }

    const now = Date.now();
    const modifier = getCurrentServantModificationName();
    const existingLocal = await db.children.get(childId);

    const merged = mergeChildRecordsPreservingPhoto(recoveryItem.childData || {}, existingLocal || {});
    if (isValidProfilePic(recoveryItem.profilePic)) {
        merged.profilePic = recoveryItem.profilePic.trim();
    }

    const restoredRecord = {
        ...merged,
        id: childId,
        syncKey: targetKey,
        oldSyncKey: null,
        movedTo: null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        restoredAt: now,
        restoredBy: modifier,
        lastModifiedBy: modifier,
        updatedAt: now,
        isDirty: !navigator.onLine
    };

    const { _rawId, _docId, _collectionSyncKey, ...cleanRestored } = restoredRecord;
    await db.children.put(cleanRestored);

    if (navigator.onLine) {
        try {
            await setDoc(
                doc(firestore, 'Osras', targetKey, 'children', childId),
                buildCloudChildDocument(cleanRestored),
                { merge: true }
            );
        } catch (err) {
            console.warn(`⚠️ [restoreDeletedOrOrphanChild] Cloud write error for ${childId}:`, err?.message);
            await db.children.update(childId, { isDirty: true });
        }
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    return true;
}

/**
 * 2b. Batch restores all children accidentally deleted/purged without a human `deletedBy` servant name.
 *
 * @param {Array<Object>} recoveryItems
 * @param {string} [fallbackSyncKey]
 * @returns {Promise<number>} Count of restored children
 */
export async function restoreBatchAccidentalDeletes(recoveryItems = [], fallbackSyncKey = '') {
    const accidentalList = (recoveryItems || []).filter(item => item.isAccidentalPurge);
    let restoredCount = 0;
    for (const item of accidentalList) {
        const targetKey = item.syncKey || fallbackSyncKey;
        if (!targetKey) continue;
        const ok = await restoreDeletedOrOrphanChild(item, targetKey);
        if (ok) restoredCount++;
    }
    return restoredCount;
}

/**
 * 3. Recovers missing `profilePic` photos from matched snapshots/copies.
 *
 * @param {Array<Object>} photoRecoveryItems
 * @returns {Promise<number>} Count of recovered photos
 */
export async function recoverMissingPhotosFromSnapshots(photoRecoveryItems = []) {
    let recoveredCount = 0;
    const now = Date.now();
    const modifier = getCurrentServantModificationName();

    for (const item of (photoRecoveryItems || [])) {
        if (!item || !item.childId || !isValidProfilePic(item.recoveredProfilePic)) continue;
        const childId = String(item.childId);
        const pic = item.recoveredProfilePic.trim();
        const existingLocal = await db.children.get(childId);
        const targetSyncKey = normalizeToValidSyncKey(item.syncKey || existingLocal?.syncKey || '');

        const updatedRecord = {
            ...(item.childData || {}),
            ...(existingLocal || {}),
            id: childId,
            syncKey: targetSyncKey || item.syncKey,
            profilePic: pic,
            photoExplicitlyRemoved: false,
            lastModifiedBy: modifier,
            updatedAt: now,
            isDirty: !navigator.onLine
        };

        const { _rawId, _docId, _collectionSyncKey, ...cleanRecord } = updatedRecord;
        await db.children.put(cleanRecord);

        if (navigator.onLine && cleanRecord.syncKey) {
            try {
                await setDoc(
                    doc(firestore, 'Osras', cleanRecord.syncKey, 'children', childId),
                    buildCloudChildDocument(cleanRecord),
                    { merge: true }
                );
            } catch (err) {
                console.warn(`⚠️ [recoverMissingPhotos] Cloud update failed for ${childId}:`, err?.message);
                await db.children.update(childId, { isDirty: true });
            }
        }
        recoveredCount++;
    }

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
    }

    return recoveredCount;
}

/**
 * 4. Force Clean Master Sync (مزامنة قسرية موحدة):
 * Pushes the verified, repaired state to Firestore so all servants, priests, and Excel exports
 * show the exact same 100% identical numbers and classes.
 *
 * @param {Array<Object>} [osrasListInput]
 * @returns {Promise<{ success: boolean, pushedCount: number, resolvedCrossClass: number, recoveredPhotos: number }>}
 */
export async function forceCleanMasterSync(osrasListInput = []) {
    if (!navigator.onLine) {
        return { success: false, pushedCount: 0, resolvedCrossClass: 0, recoveredPhotos: 0 };
    }

    const allOsras = osrasListInput && osrasListInput.length > 0
        ? osrasListInput
        : getAllConfiguredOsras();

    // 1. Run diagnostic scan first to auto-recover photos and resolve cross-class conflicts
    const audit = await scanDataIntegrityAndRecovery(allOsras);

    let recoveredPhotos = 0;
    if (audit.missingPhotoRecoveries.length > 0) {
        recoveredPhotos = await recoverMissingPhotosFromSnapshots(audit.missingPhotoRecoveries);
    }

    let resolvedCrossClass = 0;
    for (const conflict of audit.crossClassConflicts) {
        if (conflict.recommendedSyncKey) {
            await resolveCrossClassConflictChoice(conflict, conflict.recommendedSyncKey);
            resolvedCrossClass++;
        }
    }

    // 2. Push all active verified local children to their exact `Osras/${child.syncKey}/children/${cleanId}`
    const allLocalChildren = await db.children.toArray();
    const validKeySet = new Set(allOsras.map(o => String(o.syncKey).trim()).filter(Boolean));
    let pushedCount = 0;
    const now = Date.now();

    for (const child of allLocalChildren) {
        const normKey = normalizeToValidSyncKey(child.syncKey);
        if (!normKey || !validKeySet.has(normKey)) continue;

        const cleanId = String(ensureCleanChildId(child.id, child.gender));
        const recordToPush = {
            ...child,
            id: cleanId,
            syncKey: normKey,
            isDirty: false,
            updatedAt: parseTimestampMs(child.updatedAt) || now
        };
        const { _rawId, _docId, _collectionSyncKey, ...cleanRec } = recordToPush;

        try {
            await setDoc(
                doc(firestore, 'Osras', normKey, 'children', cleanId),
                buildCloudChildDocument(cleanRec),
                { merge: true }
            );
            await db.children.put(cleanRec);
            if (!cleanRec.isDeleted) pushedCount++;
        } catch (err) {
            console.warn(`⚠️ [forceCleanMasterSync] Failed pushing ${cleanId} to ${normKey}:`, err?.message);
        }
    }

    // 3. Reconcile all classes with cloud
    await reconcileAllClassesWithCloud(allOsras);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('children-updated'));
        window.dispatchEvent(new CustomEvent('global-sync-status', { detail: { status: 'success', time: Date.now() } }));
    }

    return {
        success: true,
        pushedCount,
        resolvedCrossClass,
        recoveredPhotos
    };
}
