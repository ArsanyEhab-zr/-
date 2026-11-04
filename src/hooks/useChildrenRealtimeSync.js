import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { db } from '../db/database';
import { firestore } from '../db/firebase';
import { collection, collectionGroup, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { decryptData } from '../encryption';
import { ensureCleanChildId, isCleanChildId } from '../utils/idGenerator';
import {
    buildStrictDuplicateKey,
    areStrictDuplicateChildren,
    parseTimestampMs,
    getAllConfiguredOsras
} from '../utils/nameUtils';
import { resolveProtectedProfilePic } from '../utils/imageUtils';
import {
    deduplicateCloudChildrenForClass,
    mergeChildRecordsPreservingPhoto,
    buildCloudChildDocument
} from '../db/sync';

/**
 * 🔄 useChildrenRealtimeSync — Global Real-time Firestore Listener
 *
 * Guarantees:
 * 1. Protects `profilePic` on every merge (`resolveProtectedProfilePic`): never lets an empty photo wipe a valid photo unless `photoExplicitlyRemoved === true`.
 * 2. Stops false-positive deduplication: only deduplicates records sharing the exact same `id`/`cloudId` OR the same `syncKey` + full 4-part normalized name + non-empty normalized phone.
 * 3. Prevents cross-class scrambling: a stale copy or move-tombstone in Class A never overwrites or deletes a child whose active record is in Class B with a newer `updatedAt`.
 * 4. Propagates edits (`updatedAt`, `lastModifiedBy`) and soft-deletes (`isDeleted: true`, `deletedAt`, `deletedBy`) across all servants and the Priest in real time without resurrecting deleted records.
 */
export function useChildrenRealtimeSync() {
    const location = useLocation();
    const activeSubKeyRef = useRef(null);
    const unsubsRef = useRef([]);
    const snapshotQueueRef = useRef(Promise.resolve());

    useEffect(() => {
        const currentSyncKey = localStorage.getItem('currentSyncKey');
        const currentServantStr = localStorage.getItem('currentServant') || '{}';

        const sessionKey = `${currentSyncKey || ''}_${currentServantStr}`;
        if (sessionKey === activeSubKeyRef.current) {
            return;
        }

        unsubsRef.current.forEach(unsub => {
            try { unsub(); } catch (_) {}
        });
        unsubsRef.current = [];
        activeSubKeyRef.current = sessionKey;

        if (!currentSyncKey) return;

        let parsedServant = {};
        try {
            parsedServant = JSON.parse(currentServantStr);
        } catch (_) {}
        const allowedClasses = parsedServant.allowedClasses || [];
        const isMaster =
            currentSyncKey === 'MASTER_ACCESS' ||
            currentSyncKey === 'ADMIN_MODE' ||
            parsedServant.role === 'كاهن' ||
            parsedServant.role === 'أدمن مساعد' ||
            parsedServant.role === 'Super Admin';
        const isStageAdmin = currentSyncKey === 'STAGE_ADMIN' || parsedServant.role === 'أمين مرحلة';

        /**
         * Processes a single Firestore snapshot sequentially through a promise queue
         * so multi-class snapshots in MasterDashboard never drop or race each other.
         */
        const processSnapshotInternal = async (snapshot, targetClassKey = null) => {
            if (!snapshot) return;

            try {
                const changes = snapshot.docChanges();
                const toSoftDeleteRecords = [];
                const toPut = [];
                const now = Date.now();

                const effectiveClassKey = targetClassKey || (
                    !isMaster && !isStageAdmin && currentSyncKey !== 'MASTER_ACCESS' && currentSyncKey !== 'ADMIN_MODE' && currentSyncKey !== 'STAGE_ADMIN'
                        ? currentSyncKey
                        : ''
                );

                // 1. Parse all valid docs in the snapshot
                const rawChildrenList = [];
                for (const docSnap of snapshot.docs) {
                    if (docSnap.id === '_placeholder') continue;
                    const rawData = docSnap.data();
                    if (!rawData || rawData.placeholder || rawData.isPlaceholder) continue;

                    let data = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!data) continue;

                    if (rawData.isDeleted === true) data.isDeleted = true;
                    if (rawData.movedTo) data.movedTo = rawData.movedTo;
                    if (rawData.deletedAt && !data.deletedAt) data.deletedAt = rawData.deletedAt;
                    if (rawData.deletedBy && !data.deletedBy) data.deletedBy = rawData.deletedBy;
                    if (rawData.updatedAt && parseTimestampMs(rawData.updatedAt) > parseTimestampMs(data.updatedAt)) {
                        data.updatedAt = rawData.updatedAt;
                    }

                    const docParentKey = docSnap.ref?.parent?.parent?.id || effectiveClassKey || data.syncKey || '';
                    const cleanId = String(ensureCleanChildId(data.id || docSnap.id, data.gender));
                    rawChildrenList.push({
                        ...data,
                        id: cleanId,
                        syncKey: String(docParentKey || data.syncKey || ''),
                        _rawId: docSnap.id
                    });
                }

                // 2. Strict Deduplication (ONLY exact ID or same syncKey + 4-part name + non-empty phone)
                let canonicalDocs = rawChildrenList;
                const classToDeduplicate = effectiveClassKey || (rawChildrenList[0]?.syncKey);
                if (classToDeduplicate && targetClassKey) {
                    const dedupResult = await deduplicateCloudChildrenForClass(classToDeduplicate, rawChildrenList);
                    canonicalDocs = dedupResult.canonicalChildren;
                }

                const cloudDocIds = new Set();
                const cloudStrictKeyMap = new Map(); // strictDuplicateKey -> canonicalDocId
                const canonicalById = new Map();

                for (const child of canonicalDocs) {
                    const childId = String(child.id);
                    cloudDocIds.add(childId);
                    if (child._rawId) cloudDocIds.add(String(child._rawId));
                    canonicalById.set(childId, child);

                    if (!child.isDeleted) {
                        const strictKey = buildStrictDuplicateKey(child, child.syncKey || classToDeduplicate);
                        if (strictKey) {
                            cloudStrictKeyMap.set(strictKey, childId);
                        }
                    }
                }

                // 3. Process incremental changes
                for (const change of changes) {
                    const docId = change.doc.id;
                    if (docId === '_placeholder') continue;

                    const docParentKey = change.doc.ref?.parent?.parent?.id || effectiveClassKey || '';
                    const rawData = change.doc.data();
                    let data = rawData?.payload ? decryptData(rawData.payload) : rawData;
                    if (data && typeof data === 'object') {
                        if (rawData?.isDeleted === true) data.isDeleted = true;
                        if (rawData?.movedTo) data.movedTo = rawData.movedTo;
                        if (rawData?.deletedAt && !data.deletedAt) data.deletedAt = rawData.deletedAt;
                        if (rawData?.deletedBy && !data.deletedBy) data.deletedBy = rawData.deletedBy;
                        if (rawData?.updatedAt && parseTimestampMs(rawData.updatedAt) > parseTimestampMs(data.updatedAt)) {
                            data.updatedAt = rawData.updatedAt;
                        }
                    }

                    const cleanId = String(ensureCleanChildId(data?.id || docId, data?.gender));
                    const localChild = await db.children.get(cleanId);

                    if (change.type === 'removed') {
                        // Only soft-delete if localChild belongs to this exact class and is not dirty
                        if (localChild && !localChild.isDirty) {
                            const localKey = String(localChild.syncKey || '');
                            if (!docParentKey || !localKey || localKey === docParentKey) {
                                toSoftDeleteRecords.push({
                                    ...localChild,
                                    id: cleanId,
                                    isDeleted: true,
                                    deletedAt: localChild.deletedAt || now,
                                    deletedBy: localChild.deletedBy || 'حذف سحابي مباشر',
                                    isDirty: false
                                });
                            }
                        }
                        continue;
                    }

                    if (change.type === 'added' || change.type === 'modified') {
                        if (!data || rawData?.placeholder || rawData?.isPlaceholder) continue;

                        const incomingSyncKey = String(docParentKey || data.syncKey || localChild?.syncKey || '');

                        // Cross-class protection:
                        // If localChild is currently in a DIFFERENT class, check timestamps and `movedTo` before allowing this class snapshot to touch it!
                        if (localChild && localChild.syncKey && incomingSyncKey && String(localChild.syncKey) !== incomingSyncKey) {
                            const localTime = parseTimestampMs(localChild.updatedAt);
                            const incomingTime = parseTimestampMs(data.updatedAt);

                            // If this incoming doc is a move-tombstone or deleted doc from an old class while localChild is active in another class, ignore it!
                            if (data.isDeleted || data.movedTo) {
                                if (data.movedTo && data.movedTo !== localChild.syncKey && incomingTime > localTime && !localChild.isDirty) {
                                    // Child was moved to `data.movedTo`
                                    toPut.push({
                                        ...localChild,
                                        syncKey: String(data.movedTo),
                                        isDirty: false,
                                        updatedAt: incomingTime
                                    });
                                }
                                continue;
                            }

                            // Both are active in different classes: compare `updatedAt` deterministically!
                            if (localChild.isDirty || (!localChild.isDeleted && localTime > incomingTime)) {
                                // Local class is newer! If online, tombstone this stale ghost copy in Firestore so it stops jumping!
                                if (navigator.onLine && !localChild.isDirty && docParentKey) {
                                    try {
                                        const staleTombstone = {
                                            ...data,
                                            id: cleanId,
                                            syncKey: docParentKey,
                                            isDeleted: true,
                                            movedTo: localChild.syncKey,
                                            deletedAt: now,
                                            deletedBy: 'منع تكرار الفصول التلقائي',
                                            updatedAt: localTime
                                        };
                                        setDoc(
                                            doc(firestore, 'Osras', docParentKey, 'children', cleanId),
                                            buildCloudChildDocument(staleTombstone),
                                            { merge: true }
                                        ).catch(() => {});
                                    } catch (_) {}
                                }
                                continue;
                            }
                        }

                        // Handle incoming soft-deletion (`isDeleted: true`)
                        if (data.isDeleted) {
                            // If this is a `movedTo` tombstone pointing to another class, and localChild is in that target class, do not delete!
                            if (data.movedTo && localChild && String(localChild.syncKey) === String(data.movedTo)) {
                                continue;
                            }

                            // Only allow local to remain active if Admin explicitly restored it more recently than deletedAt
                            const restoredAt = parseTimestampMs(localChild?.restoredAt);
                            const deletedAt = Math.max(parseTimestampMs(data.deletedAt), parseTimestampMs(data.updatedAt));
                            if (localChild && localChild.isDirty && restoredAt > deletedAt) {
                                continue;
                            }

                            const mergedTombstone = mergeChildRecordsPreservingPhoto(data, localChild);
                            const { _rawId, _docId, _collectionSyncKey, ...cleanTombstone } = mergedTombstone;
                            toSoftDeleteRecords.push({
                                ...cleanTombstone,
                                id: cleanId,
                                syncKey: incomingSyncKey,
                                isDeleted: true,
                                deletedAt: data.deletedAt || localChild?.deletedAt || now,
                                deletedBy: data.deletedBy || localChild?.deletedBy || '',
                                movedTo: data.movedTo || null,
                                isDirty: false
                            });
                            continue;
                        }

                        // Incoming record is active (`!data.isDeleted`):
                        // Check if this doc was rejected as a strict duplicate loser in the same class
                        const strictKey = buildStrictDuplicateKey(data, incomingSyncKey);
                        if (strictKey && cloudStrictKeyMap.has(strictKey) && cloudStrictKeyMap.get(strictKey) !== cleanId) {
                            continue;
                        }

                        // Preserve uncommitted offline changes on this device
                        if (localChild && localChild.isDirty) {
                            // Still protect photo if local photo is empty and cloud has one
                            if (!localChild.profilePic && data.profilePic && localChild.photoExplicitlyRemoved !== true) {
                                await db.children.update(cleanId, {
                                    profilePic: resolveProtectedProfilePic(data, localChild)
                                });
                            }
                            continue;
                        }

                        // CRITICAL (Part 4.2): Never resurrect a locally deleted child unless explicitly restored on cloud (`restoredAt > localDeletedAt`)
                        if (localChild && localChild.isDeleted) {
                            const cloudRestoredAt = parseTimestampMs(data.restoredAt);
                            const localDeletedAt = Math.max(parseTimestampMs(localChild.deletedAt), parseTimestampMs(localChild.updatedAt));
                            if (cloudRestoredAt <= localDeletedAt) {
                                continue;
                            }
                        }

                        // Merge cloud record with local record while ALWAYS protecting `profilePic` (Part 1.2)
                        const canonicalSource = canonicalById.get(cleanId) || data;
                        const merged = mergeChildRecordsPreservingPhoto(canonicalSource, localChild);
                        const { _rawId, _docId, _collectionSyncKey, ...cleanRecord } = merged;

                        toPut.push({
                            ...cleanRecord,
                            id: cleanId,
                            syncKey: incomingSyncKey,
                            isDirty: false,
                            isDeleted: false,
                            deletedAt: null,
                            deletedBy: null,
                            movedTo: null,
                            updatedAt: canonicalSource.updatedAt || now
                        });
                    }
                }

                // 4. Scoped reconciliation for this specific class
                if (effectiveClassKey) {
                    const localScopedChildren = await db.children.where('syncKey').equals(effectiveClassKey).toArray();
                    for (const localChild of localScopedChildren) {
                        if (localChild.isDeleted || localChild.isDirty) continue;
                        const localIdStr = String(localChild.id);

                        // a. Strict Duplicate Check (ONLY 4-part name + non-empty phone in same class)
                        const strictLocalKey = buildStrictDuplicateKey(localChild, effectiveClassKey);
                        if (strictLocalKey && cloudStrictKeyMap.has(strictLocalKey)) {
                            const canonicalId = cloudStrictKeyMap.get(strictLocalKey);
                            if (localIdStr !== canonicalId) {
                                const canonicalCloud = canonicalById.get(canonicalId);
                                if (canonicalCloud && areStrictDuplicateChildren(localChild, canonicalCloud, effectiveClassKey)) {
                                    if (navigator.onLine) {
                                        try {
                                            deleteDoc(doc(firestore, 'Osras', effectiveClassKey, 'children', localIdStr)).catch(() => {});
                                        } catch (_) {}
                                    }
                                    await db.children.delete(localChild.id);
                                    continue;
                                }
                            }
                        }

                        // b. If local record is not in this class's cloud snapshot and is not a fresh offline creation:
                        if (!cloudDocIds.has(localIdStr)) {
                            const isFreshOffline = localChild.isDirty && !localChild.isDeleted && isCleanChildId(localChild.id);
                            if (!isFreshOffline) {
                                toSoftDeleteRecords.push({
                                    ...localChild,
                                    isDeleted: true,
                                    deletedAt: now,
                                    deletedBy: 'حذف سحابي سابق (تلقائي)',
                                    isDirty: false
                                });
                            }
                        }
                    }
                }

                // 5. Apply soft-deletions and updates to local Dexie
                if (toSoftDeleteRecords.length > 0) {
                    await db.children.bulkPut(toSoftDeleteRecords);
                }

                if (toPut.length > 0) {
                    await db.children.bulkPut(toPut);
                }
            } catch (err) {
                console.warn('⚠️ [RealtimeSync] Snapshot processing warning:', err);
            }
        };

        const handleSnapshot = (snapshot, targetClassKey = null) => {
            snapshotQueueRef.current = snapshotQueueRef.current
                .then(() => processSnapshotInternal(snapshot, targetClassKey))
                .catch(err => console.warn('⚠️ [RealtimeSync] Queue error:', err));
        };

        /**
         * Process Firestore snapshot changes for attendance in real time
         */
        const handleAttendanceSnapshot = async (snapshot, targetClassKey = null) => {
            if (!snapshot) return;
            try {
                const changes = snapshot.docChanges();
                const now = new Date().toISOString();

                for (const change of changes) {
                    const docId = change.doc.id;
                    if (docId === '_placeholder') continue;
                    const rawData = change.doc.data();
                    if (!rawData || rawData.placeholder || rawData.isPlaceholder) continue;

                    let data = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!data || !data.date || !data.childId || !data.type) continue;

                    const date = String(data.date);
                    const childId = String(data.childId);
                    const type = String(data.type);

                    const existingRecords = await db.attendance
                        .where('date')
                        .equals(date)
                        .filter(a => String(a.childId) === childId && a.type === type)
                        .toArray();

                    if (change.type === 'removed' || data.isDeleted) {
                        for (const rec of existingRecords) {
                            if (!rec.isDirty) {
                                try { await db.attendance.delete(rec.id); } catch (_) {}
                            }
                        }
                    } else if (change.type === 'added' || change.type === 'modified') {
                        const docParentKey = change.doc.ref?.parent?.parent?.id;
                        const effectiveSyncKey = String(targetClassKey || docParentKey || data.syncKey || currentSyncKey || '');
                        const attPayload = {
                            ...data,
                            childId: data.childId,
                            syncKey: effectiveSyncKey,
                            isDirty: false,
                            isDeleted: false,
                            updatedAt: data.updatedAt || now
                        };

                        if (existingRecords.length > 0) {
                            const first = existingRecords[0];
                            if (!first.isDirty) {
                                await db.attendance.put({ ...attPayload, id: first.id });
                            }
                            for (let i = 1; i < existingRecords.length; i++) {
                                try { await db.attendance.delete(existingRecords[i].id); } catch (_) {}
                            }
                        } else {
                            if (attPayload.id !== undefined) {
                                const collision = await db.attendance.get(attPayload.id);
                                if (collision && (String(collision.childId) !== childId || collision.date !== date || collision.type !== type)) {
                                    delete attPayload.id;
                                }
                            }
                            await db.attendance.put(attPayload);
                        }
                    }
                }
            } catch (err) {
                console.warn('⚠️ [RealtimeSync] Attendance snapshot error:', err);
            }
        };

        try {
            if (isMaster && (currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE')) {
                const allConfiguredOsras = getAllConfiguredOsras();
                const activeOsraKeys = allConfiguredOsras.map(o => o.syncKey).filter(Boolean);

                if (activeOsraKeys.length > 0) {
                    for (const classKey of activeOsraKeys) {
                        const childRef = collection(firestore, 'Osras', classKey, 'children');
                        const attRef = collection(firestore, 'Osras', classKey, 'attendance');

                        unsubsRef.current.push(onSnapshot(
                            childRef,
                            snap => handleSnapshot(snap, classKey),
                            err => console.warn(`⚠️ [RealtimeSync] Class ${classKey} error:`, err?.message)
                        ));
                        unsubsRef.current.push(onSnapshot(
                            attRef,
                            snap => handleAttendanceSnapshot(snap, classKey),
                            err => console.warn(`⚠️ [RealtimeSync] Class ${classKey} attendance error:`, err?.message)
                        ));
                    }
                } else {
                    const q = collectionGroup(firestore, 'children');
                    unsubsRef.current.push(onSnapshot(
                        q,
                        snap => handleSnapshot(snap, null),
                        err => console.warn('⚠️ [RealtimeSync] Master query error:', err?.message)
                    ));
                    const attGroup = collectionGroup(firestore, 'attendance');
                    unsubsRef.current.push(onSnapshot(
                        attGroup,
                        snap => handleAttendanceSnapshot(snap, null),
                        err => console.warn('⚠️ [RealtimeSync] Master attendance query error:', err?.message)
                    ));
                }
            } else if (isStageAdmin && currentSyncKey === 'STAGE_ADMIN') {
                for (const classKey of allowedClasses) {
                    const childRef = collection(firestore, 'Osras', classKey, 'children');
                    const attRef = collection(firestore, 'Osras', classKey, 'attendance');

                    unsubsRef.current.push(onSnapshot(
                        childRef,
                        snap => handleSnapshot(snap, classKey),
                        err => console.warn(`⚠️ [RealtimeSync] Stage class ${classKey} error:`, err?.message)
                    ));
                    unsubsRef.current.push(onSnapshot(
                        attRef,
                        snap => handleAttendanceSnapshot(snap, classKey),
                        err => console.warn(`⚠️ [RealtimeSync] Stage class ${classKey} attendance error:`, err?.message)
                    ));
                }
            } else {
                const childRef = collection(firestore, 'Osras', currentSyncKey, 'children');
                const attRef = collection(firestore, 'Osras', currentSyncKey, 'attendance');

                unsubsRef.current.push(onSnapshot(
                    childRef,
                    snap => handleSnapshot(snap, currentSyncKey),
                    err => console.warn(`⚠️ [RealtimeSync] Class ${currentSyncKey} error:`, err?.message)
                ));
                unsubsRef.current.push(onSnapshot(
                    attRef,
                    snap => handleAttendanceSnapshot(snap, currentSyncKey),
                    err => console.warn(`⚠️ [RealtimeSync] Class ${currentSyncKey} attendance error:`, err?.message)
                ));
            }
        } catch (setupErr) {
            console.warn('⚠️ [RealtimeSync] Failed to initialize Firestore listener:', setupErr);
        }

        return () => {
            unsubsRef.current.forEach(unsub => {
                try { unsub(); } catch (_) {}
            });
            unsubsRef.current = [];
            activeSubKeyRef.current = null;
        };
    }, [location.pathname]);
}

export default useChildrenRealtimeSync;
export { useChildrenRealtimeSync as useRealtimeChildren };
