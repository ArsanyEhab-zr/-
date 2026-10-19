import { db } from './database';
import { firestore } from './firebase';
import { collection, collectionGroup, getDocs, doc, setDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { encryptData, decryptData } from '../encryption';
import { generateChildId, isCleanChildId } from '../utils/idGenerator';

// Helper to clean undefined fields before Firestore write
const cleanData = (obj) => {
    const cleaned = { ...obj };
    for (const key in cleaned) {
        if (cleaned[key] === undefined) {
            delete cleaned[key];
        }
    }
    return cleaned;
};

let isMigrationRunning = false;
let hasRunMigrationThisSession = false;

/**
 * Runs migration across local Dexie storage.
 * Safely updates any child whose ID starts with 'id_' or is malformed/ugly.
 * Updates foreign keys in attendance and grades.
 * 
 * @returns {Promise<Map<string, { newId: string, child: any }>>} Map of oldId -> { newId, child }
 */
export async function runLocalIdMigration() {
    try {
        const children = await db.children.toArray();
        if (!children || children.length === 0) return new Map();

        const existingIds = new Set(children.map(c => c.id).filter(Boolean));
        const malformedChildren = children.filter(c => !isCleanChildId(c.id));

        if (malformedChildren.length === 0) {
            return new Map();
        }

        console.log(`🧹 [Local ID Migration] Found ${malformedChildren.length} children with legacy/malformed IDs. Migrating...`);
        const idMap = new Map();
        const now = new Date().toISOString();

        for (const child of malformedChildren) {
            const oldId = String(child.id);
            const newId = generateChildId(child.gender, undefined, existingIds);
            existingIds.add(newId);

            console.log(`  🔄 [Local] Migrating child "${child.name}": ${oldId} ➔ ${newId}`);

            const updatedChild = {
                ...child,
                id: newId,
                isDirty: true,
                updatedAt: now
            };

            // In Dexie primary key is immutable on in-place update, so put new record then delete old record
            await db.children.put(updatedChild);
            await db.children.delete(child.id);

            // Update attendance foreign keys in Dexie
            const allAttendance = await db.attendance.toArray();
            const matchingAtt = allAttendance.filter(a => String(a.childId) === oldId);
            for (const att of matchingAtt) {
                await db.attendance.update(att.id, {
                    childId: newId,
                    isDirty: true,
                    updatedAt: now
                });
            }

            // Update grades foreign keys in Dexie
            const allGrades = await db.grades.toArray();
            const matchingGrades = allGrades.filter(g => String(g.childId) === oldId);
            for (const grade of matchingGrades) {
                await db.grades.update(grade.id, {
                    childId: newId,
                    isDirty: true,
                    updatedAt: now
                });
            }

            // Update localStorage parentChildId if it references oldId
            if (localStorage.getItem('parentChildId') === oldId) {
                localStorage.setItem('parentChildId', newId);
            }

            idMap.set(oldId, { newId, child: updatedChild });
        }

        console.log(`✅ [Local ID Migration] Successfully migrated ${idMap.size} local children.`);
        return idMap;
    } catch (error) {
        console.error('❌ [Local ID Migration] Error:', error);
        return new Map();
    }
}

/**
 * Runs migration across Firebase Firestore.
 * Finds any child document with an ugly/malformed ID or from localIdMap,
 * creates the new document with clean ID, deletes the old document,
 * and updates attendance and grade references in Firestore.
 * 
 * @param {Map<string, { newId: string, child: any }>} [localIdMap]
 */
export async function runCloudIdMigration(localIdMap = new Map()) {
    if (!navigator.onLine) {
        console.log('ℹ️ [Cloud ID Migration] Device offline, skipping cloud migration.');
        return;
    }

    try {
        console.log('☁️ [Cloud ID Migration] Scanning Firestore for legacy/malformed child documents...');
        
        let cloudChildrenDocs = [];
        try {
            const snapshot = await getDocs(collectionGroup(firestore, 'children'));
            cloudChildrenDocs = snapshot.docs || [];
        } catch (groupErr) {
            console.warn('⚠️ [Cloud ID Migration] collectionGroup query failed, querying currentSyncKey...', groupErr?.message);
            const currentSyncKey = localStorage.getItem('currentSyncKey');
            if (currentSyncKey && currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE') {
                const snapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'children'));
                cloudChildrenDocs = snapshot.docs || [];
            }
        }

        const now = new Date().toISOString();
        const fullMigrationMap = new Map(localIdMap);

        // 1. Process all cloud children that have malformed IDs
        for (const docSnap of cloudChildrenDocs) {
            if (docSnap.id === '_placeholder' || docSnap.id.startsWith('_')) continue;

            const syncKey = docSnap.ref.parent?.parent?.id || localStorage.getItem('currentSyncKey');
            if (!syncKey || syncKey === 'MASTER_ACCESS' || syncKey === 'ADMIN_MODE' || syncKey === 'STAGE_ADMIN') continue;

            const isMalformed = !isCleanChildId(docSnap.id);
            const isKnownLocalMigrated = localIdMap.has(docSnap.id);

            if (isMalformed || isKnownLocalMigrated) {
                const rawData = docSnap.data();
                let childData = rawData?.payload ? decryptData(rawData.payload) : rawData;
                if (!childData) childData = { id: docSnap.id };

                let newId;
                if (localIdMap.has(docSnap.id)) {
                    newId = localIdMap.get(docSnap.id).newId;
                } else {
                    newId = generateChildId(childData.gender);
                }

                fullMigrationMap.set(docSnap.id, { newId, child: childData, syncKey });

                console.log(`  ☁️ [Cloud] Migrating document in Osra (${syncKey}): ${docSnap.id} ➔ ${newId}`);

                // Write new document with clean ID
                const newDocRef = doc(firestore, 'Osras', syncKey, 'children', newId);
                const cloudPayload = encryptData(cleanData({
                    ...childData,
                    id: newId,
                    syncKey,
                    isDirty: false,
                    isDeleted: false,
                    updatedAt: now
                }));
                await setDoc(newDocRef, { payload: cloudPayload }, { merge: true });

                // Delete old document with ugly ID
                try {
                    await deleteDoc(docSnap.ref);
                } catch (delErr) {
                    console.warn(`  ⚠️ Failed deleting old child doc ${docSnap.id}:`, delErr?.message);
                }
            }
        }

        if (fullMigrationMap.size === 0) {
            console.log('✅ [Cloud ID Migration] No malformed documents found in Firestore.');
            return;
        }

        // 2. Migrate attendance in Firestore for any migrated IDs
        try {
            console.log(`☁️ [Cloud ID Migration] Checking attendance references for ${fullMigrationMap.size} migrated children...`);
            let attDocs = [];
            try {
                const attSnapshot = await getDocs(collectionGroup(firestore, 'attendance'));
                attDocs = attSnapshot.docs || [];
            } catch (attGroupErr) {
                const currentSyncKey = localStorage.getItem('currentSyncKey');
                if (currentSyncKey && currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE') {
                    const attSnapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'attendance'));
                    attDocs = attSnapshot.docs || [];
                }
            }

            for (const attDoc of attDocs) {
                if (attDoc.id === '_placeholder' || attDoc.id.startsWith('_')) continue;
                const rawAtt = attDoc.data();
                const attData = rawAtt?.payload ? decryptData(rawAtt.payload) : rawAtt;
                if (!attData) continue;

                const attChildId = String(attData.childId || '');
                const hasMatch = fullMigrationMap.has(attChildId) || Array.from(fullMigrationMap.keys()).some(oldId => attDoc.id.includes(`_${oldId}_`));

                if (hasMatch) {
                    const matchedOldId = fullMigrationMap.has(attChildId) 
                        ? attChildId 
                        : Array.from(fullMigrationMap.keys()).find(oldId => attDoc.id.includes(`_${oldId}_`));
                    
                    const { newId } = fullMigrationMap.get(matchedOldId);
                    const attSyncKey = attDoc.ref.parent?.parent?.id || attData.syncKey;
                    if (!attSyncKey) continue;

                    const updatedAtt = {
                        ...attData,
                        childId: newId,
                        syncKey: attSyncKey,
                        isDirty: false,
                        isDeleted: false,
                        updatedAt: now
                    };
                    const newAttDocId = `${updatedAtt.date}_${newId}_${updatedAtt.type}`;
                    const newAttRef = doc(firestore, 'Osras', attSyncKey, 'attendance', newAttDocId);
                    await setDoc(newAttRef, { payload: encryptData(cleanData(updatedAtt)) }, { merge: true });
                    try {
                        await deleteDoc(attDoc.ref);
                    } catch (_e) { /* ignore */ }
                    console.log(`  └─ [Cloud Attendance] Migrated: ${attDoc.id} ➔ ${newAttDocId}`);
                }
            }
        } catch (attErr) {
            console.warn('⚠️ [Cloud ID Migration] Error migrating cloud attendance:', attErr?.message);
        }

        // 3. Migrate exam grades in Firestore for any migrated IDs
        try {
            console.log(`☁️ [Cloud ID Migration] Checking exam grades for ${fullMigrationMap.size} migrated children...`);
            let examDocs = [];
            try {
                const examsSnapshot = await getDocs(collectionGroup(firestore, 'exams'));
                examDocs = examsSnapshot.docs || [];
            } catch (examGroupErr) {
                const currentSyncKey = localStorage.getItem('currentSyncKey');
                if (currentSyncKey && currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE') {
                    const examsSnapshot = await getDocs(collection(firestore, 'Osras', currentSyncKey, 'exams'));
                    examDocs = examsSnapshot.docs || [];
                }
            }

            for (const examDoc of examDocs) {
                const examFirebaseId = examDoc.id;
                const examSyncKey = examDoc.ref.parent?.parent?.id;
                if (!examSyncKey) continue;

                for (const [oldId, { newId }] of fullMigrationMap.entries()) {
                    const oldGradeRef = doc(firestore, 'Osras', examSyncKey, 'exams', examFirebaseId, 'grades', String(oldId));
                    try {
                        const oldGradeSnap = await getDoc(oldGradeRef);
                        if (oldGradeSnap.exists()) {
                            const rawGrade = oldGradeSnap.data();
                            const gradeData = rawGrade?.payload ? decryptData(rawGrade.payload) : rawGrade;
                            if (gradeData) {
                                const updatedGrade = {
                                    ...gradeData,
                                    childId: newId,
                                    updatedAt: now
                                };
                                const newGradeRef = doc(firestore, 'Osras', examSyncKey, 'exams', examFirebaseId, 'grades', String(newId));
                                await setDoc(newGradeRef, { payload: encryptData(cleanData(updatedGrade)) }, { merge: true });
                                await deleteDoc(oldGradeRef);
                                console.log(`  └─ [Cloud Grade] Exam ${examFirebaseId}: Migrated ${oldId} ➔ ${newId}`);
                            }
                        }
                    } catch (_gradeErr) { /* ignore missing */ }
                }
            }
        } catch (gradeErr) {
            console.warn('⚠️ [Cloud ID Migration] Error migrating cloud grades:', gradeErr?.message);
        }

        console.log(`✨ [Cloud ID Migration] Firestore migration finished successfully! Migrated ${fullMigrationMap.size} children.`);
    } catch (error) {
        console.error('❌ [Cloud ID Migration] Error:', error);
    }
}

/**
 * Master migration runner.
 * First migrates local Dexie storage immediately, then migrates Firebase Firestore if online.
 * Runs only once per session unless force=true.
 */
export async function runIdMigration(force = false) {
    if (hasRunMigrationThisSession && !force) return;
    if (isMigrationRunning) return;
    isMigrationRunning = true;
    try {
        const localIdMap = await runLocalIdMigration();
        if (navigator.onLine) {
            await runCloudIdMigration(localIdMap);
        }
        hasRunMigrationThisSession = true;
    } catch (err) {
        console.error('❌ [Migration] Master runner error:', err);
    } finally {
        isMigrationRunning = false;
    }
}
