import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { db } from '../db/database';
import { firestore } from '../db/firebase';
import { collection, collectionGroup, onSnapshot } from 'firebase/firestore';
import { decryptData } from '../encryption';
import { ensureCleanChildId, isCleanChildId } from '../utils/idGenerator';
import { normalizeArabicName } from '../utils/nameUtils';
import { safePurgeLocalChild } from '../db/sync';

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
            if (!snapshot || isProcessingRef.current) return;
            isProcessingRef.current = true;

            try {
                const changes = snapshot.docChanges();
                const cloudDocIds = new Set();
                const cloudNameMap = new Map(); // normalizedName -> canonicalDocId
                const toDeleteIds = new Set();
                const toPut = [];
                const now = new Date().toISOString();

                // 1. Build authoritative sets from all docs in the snapshot
                for (const docSnap of snapshot.docs) {
                    if (docSnap.id === '_placeholder') continue;
                    const rawData = docSnap.data();
                    if (!rawData || rawData.placeholder || rawData.isPlaceholder) continue;

                    let data = rawData.payload ? decryptData(rawData.payload) : rawData;
                    if (!data) continue;

                    const childId = String(data.id || docSnap.id);
                    cloudDocIds.add(childId);
                    cloudDocIds.add(String(docSnap.id));

                    const normName = normalizeArabicName(data.name);
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

                        const childId = data.id || docId;
                        if (data.isDeleted) {
                            toDeleteIds.add(childId);
                        } else {
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

                // 3. Strict Cloud-to-Local Reconciliation Check
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
                            console.log(`🧹 [RealtimeSync] Purging duplicate local child "${localChild.name}" (old ID: ${localChild.id}, canonical: ${canonicalId})`);
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
                            console.log(`🗑️ [RealtimeSync] Purging cloud-deleted/ghost local record "${localChild.name}" (ID: ${localChild.id})`);
                            toDeleteIds.add(localChild.id);
                        }
                    }
                }

                // 4. Execute deletions in Dexie
                if (toDeleteIds.size > 0) {
                    for (const delId of toDeleteIds) {
                        await safePurgeLocalChild(delId);
                    }
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

        try {
            if (isMaster) {
                // Subscribe to each registered class individually for 100% precision and reliability
                const saved = localStorage.getItem('appSettings');
                const parsed = saved ? JSON.parse(saved) : {};
                const activeOsraKeys = (parsed.services || []).flatMap(s => s.osras || []).map(o => o.syncKey).filter(Boolean);

                if (activeOsraKeys.length > 0) {
                    for (const classKey of activeOsraKeys) {
                        const ref = collection(firestore, 'Osras', classKey, 'children');
                        const unsub = onSnapshot(
                            ref,
                            snap => handleSnapshot(snap, classKey),
                            err => console.warn(`⚠️ [RealtimeSync] Class ${classKey} error:`, err?.message)
                        );
                        unsubsRef.current.push(unsub);
                    }
                } else {
                    const q = collectionGroup(firestore, 'children');
                    const unsub = onSnapshot(
                        q, 
                        snap => handleSnapshot(snap, null), 
                        err => console.warn('⚠️ [RealtimeSync] Master query error:', err?.message)
                    );
                    unsubsRef.current.push(unsub);
                }
            } else if (isStageAdmin) {
                for (const classKey of allowedClasses) {
                    const ref = collection(firestore, 'Osras', classKey, 'children');
                    const unsub = onSnapshot(
                        ref, 
                        snap => handleSnapshot(snap, classKey), 
                        err => console.warn(`⚠️ [RealtimeSync] Stage class ${classKey} error:`, err?.message)
                    );
                    unsubsRef.current.push(unsub);
                }
            } else {
                const ref = collection(firestore, 'Osras', currentSyncKey, 'children');
                const unsub = onSnapshot(
                    ref, 
                    snap => handleSnapshot(snap, currentSyncKey), 
                    err => console.warn(`⚠️ [RealtimeSync] Class ${currentSyncKey} error:`, err?.message)
                );
                unsubsRef.current.push(unsub);
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
