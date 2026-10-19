import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { db } from '../db/database';
import { firestore } from '../db/firebase';
import { collection, collectionGroup, onSnapshot, doc, deleteDoc } from 'firebase/firestore';
import { decryptData } from '../encryption';
import { ensureCleanChildId, isCleanChildId } from '../utils/idGenerator';
import { normalizeArabicName } from '../utils/nameUtils';
import { deduplicateCloudChildrenForClass } from '../db/sync';

/**
 * 🔄 useRealtimeChildren — Global Real-time Firestore Listener
 * 
 * Synchronizes child additions, modifications, and immediate deletions across
 * all connected servants in real time using Firestore onSnapshot.
 * 
 * - When a servant deletes a child on Device A, Firestore fires a 'removed' event
 *   or tombstone which purges the child from local Dexie on Device B instantly (<200ms).
 * - Also performs strict reconciliation on snapshot arrival so ghost records,
 *   duplicate records, and stale pre-migration records are purged immediately.
 */
export default function useRealtimeChildren() {
    const location = useLocation();
    const activeSubKeyRef = useRef(null);
    const unsubsRef = useRef([]);
    const isProcessingRef = useRef(false);
    const isPurging = useRef(false);

    useEffect(() => {
        const currentSyncKey = localStorage.getItem('currentSyncKey');
        const currentServantStr = localStorage.getItem('currentServant') || '{}';
        
        // Form a session identifier to only recreate subscriptions when auth/osra changes
        const sessionKey = `${currentSyncKey || ''}_${currentServantStr}`;
        if (sessionKey === activeSubKeyRef.current) {
            return;
        }

        // Clean up any existing listeners before setting up new ones
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
        const isMaster = currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE' || parsedServant.role === 'كاهن' || parsedServant.role === 'أدمن مساعد' || parsedServant.role === 'Super Admin';
        const isStageAdmin = currentSyncKey === 'STAGE_ADMIN' || parsedServant.role === 'أمين مرحلة';

        /**
         * Process Firestore snapshot changes and strictly reconcile with local Dexie database
         */
        const handleSnapshot = async (snapshot, targetClassKey = null) => {
            if (!snapshot || isProcessingRef.current || isPurging.current) return;
            isProcessingRef.current = true;

            try {
                const changes = snapshot.docChanges();
                const toDeleteIds = new Set();
                const toPut = [];
                const now = new Date().toISOString();

                const effectiveClassKey = targetClassKey || (
                    !isMaster && !isStageAdmin ? currentSyncKey : ''
                );

                // 1. Parse all valid docs in the snapshot
                const rawChildrenList = [];
                for (const docSnap of snapshot.docs) {
                    if (docSnap.id === '_placeholder') continue;
                    const rawData = docSnap.data();
                    if (!rawData || rawData.placeholder || rawData.isPlaceholder) continue;

                    let data = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!data) continue;

                    const cleanId = ensureCleanChildId(data.id || docSnap.id, data.gender);
                    rawChildrenList.push({
                        ...data,
                        id: cleanId,
                        _rawId: docSnap.id
                    });
                }

                // Permanent Cloud + Local Deduplication by Normalized Name
                let canonicalDocs = rawChildrenList;
                const classToDeduplicate = effectiveClassKey || (rawChildrenList[0]?.syncKey);
                if (classToDeduplicate) {
                    const dedupResult = await deduplicateCloudChildrenForClass(classToDeduplicate, rawChildrenList);
                    canonicalDocs = dedupResult.canonicalChildren;
                }

                const cloudDocIds = new Set();
                const cloudNameMap = new Map(); // normalizedName -> canonicalDocId

                for (const child of canonicalDocs) {
                    const childId = String(child.id);
                    cloudDocIds.add(childId);
                    if (child._rawId) cloudDocIds.add(String(child._rawId));

                    const normName = normalizeArabicName(child.name);
                    if (normName) {
                        cloudNameMap.set(normName, childId);
                    }
                }

                // 2. Process incremental changes
                for (const change of changes) {
                    const docId = change.doc.id;
                    if (docId === '_placeholder') continue;

                    if (change.type === 'removed') {
                        toDeleteIds.add(docId);
                        continue;
                    }

                    if (change.type === 'added' || change.type === 'modified') {
                        const rawData = change.doc.data();
                        if (!rawData || rawData.placeholder || rawData.isPlaceholder) continue;

                        let data = rawData.payload ? decryptData(rawData.payload) : rawData;
                        if (!data) continue;

                        const childId = String(data.id || docId);
                        if (data.isDeleted) {
                            toDeleteIds.add(childId);
                        } else {
                            // Check if this doc was rejected as an obsolete duplicate loser
                            const normName = normalizeArabicName(data.name);
                            if (normName && cloudNameMap.has(normName) && cloudNameMap.get(normName) !== childId) {
                                toDeleteIds.add(childId);
                                continue;
                            }

                            // Verify if local child has uncommitted offline changes (isDirty)
                            const localChild = await db.children.get(childId);
                            if (localChild && localChild.isDirty) {
                                continue; // Preserve servant's local edits until synced
                            }

                            const cleanId = ensureCleanChildId(childId, data.gender);
                            const effectiveSyncKey = targetClassKey || data.syncKey || (
                                !isMaster && !isStageAdmin ? currentSyncKey : (localChild?.syncKey || '')
                            );

                            toPut.push({
                                ...data,
                                id: cleanId,
                                syncKey: String(effectiveSyncKey || ''),
                                isDirty: false,
                                isDeleted: false,
                                updatedAt: data.updatedAt || now
                            });
                        }
                    }
                }

                // 3. Strict Cloud-to-Local Reconciliation Check & Batch Deduplication
                if (isPurging.current) return;
                isPurging.current = true;
                try {
                    // Scoped query for local children
                    let localScopedChildren = [];
                    if (targetClassKey) {
                        localScopedChildren = await db.children.where('syncKey').equals(targetClassKey).toArray();
                    } else if (!isMaster && !isStageAdmin) {
                        localScopedChildren = await db.children.where('syncKey').equals(currentSyncKey).toArray();
                    } else if (isMaster) {
                        localScopedChildren = await db.children.toArray();
                    }

                    for (const localChild of localScopedChildren) {
                        const localIdStr = String(localChild.id);

                        // a. Mark deleted records for purge
                        if (localChild.isDeleted) {
                            toDeleteIds.add(localChild.id);
                            continue;
                        }

                        // b. Duplicate Name Safeguard:
                        // If local record shares the same normalized name with a cloud record
                        // but has a different/legacy ID, it is an obsolete duplicate!
                        const normLocalName = normalizeArabicName(localChild.name);
                        if (normLocalName && cloudNameMap.has(normLocalName)) {
                            const canonicalId = cloudNameMap.get(normLocalName);
                            if (localIdStr !== canonicalId && String(localChild.id) !== canonicalId) {
                                if (navigator.onLine && classToDeduplicate) {
                                    try {
                                        deleteDoc(doc(firestore, 'Osras', classToDeduplicate, 'children', localIdStr)).catch(() => {});
                                    } catch (_) {}
                                }
                                toDeleteIds.add(localChild.id);
                                continue;
                            }
                        }

                        // c. Ghost / Cloud-Deleted Safeguard:
                        // If local record is NOT in cloud snapshot:
                        if (!cloudDocIds.has(localIdStr) && !cloudDocIds.has(String(localChild.id))) {
                            // Is this a genuinely new offline record?
                            const isFreshOffline = localChild.isDirty && !localChild.isDeleted && isCleanChildId(localChild.id);
                            if (!isFreshOffline) {
                                toDeleteIds.add(localChild.id);
                            }
                        }
                    }

                    // 4. Batch Deletions in Dexie
                    if (toDeleteIds.size > 0) {
                        const rawIdsToDelete = Array.from(toDeleteIds);
                        const keysToDeleteSet = new Set();
                        rawIdsToDelete.forEach(id => {
                            if (id !== undefined && id !== null) {
                                keysToDeleteSet.add(id);
                                const num = Number(id);
                                if (!isNaN(num) && Number.isFinite(num)) {
                                    keysToDeleteSet.add(num);
                                }
                            }
                        });
                        const keysToDelete = Array.from(keysToDeleteSet);

                        if (keysToDelete.length > 0) {
                            await db.children.bulkDelete(keysToDelete);

                            // Clean up associated attendance & grades in batch
                            try {
                                const strKeys = rawIdsToDelete.map(String);
                                await db.attendance.where('childId').anyOf(strKeys).delete();
                                await db.grades.where('childId').anyOf(strKeys).delete();
                            } catch (_) {}

                            console.log(`[RealtimeSync] Purged ${rawIdsToDelete.length} duplicates`);
                        }
                    }
                } finally {
                    isPurging.current = false;
                }

                // 5. Bulk put updated/added children
                if (toPut.length > 0) {
                    await db.children.bulkPut(toPut);
                }

            } catch (err) {
                console.warn('⚠️ [RealtimeSync] Snapshot processing warning:', err);
            } finally {
                isProcessingRef.current = false;
            }
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
                        const effectiveSyncKey = String(targetClassKey || data.syncKey || currentSyncKey || '');
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
                            // Clean up duplicates if any
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
            if (isMaster) {
                // Subscribe to each registered class individually for 100% precision and reliability
                const saved = localStorage.getItem('appSettings');
                const parsed = saved ? JSON.parse(saved) : {};
                const activeOsraKeys = (parsed.services || []).flatMap(s => s.osras || []).map(o => o.syncKey).filter(Boolean);

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
            } else if (isStageAdmin) {
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
