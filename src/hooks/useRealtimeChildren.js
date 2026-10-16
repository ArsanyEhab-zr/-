import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { db } from '../db/database';
import { firestore } from '../db/firebase';
import { collection, collectionGroup, onSnapshot } from 'firebase/firestore';
import { decryptData } from '../encryption';
import { ensureCleanChildId } from '../utils/idGenerator';
import { safePurgeLocalChild } from '../db/sync';

/**
 * 🔄 useRealtimeChildren — Global Real-time Firestore Listener
 * 
 * Synchronizes child additions, modifications, and immediate deletions across
 * all connected servants in real time using Firestore onSnapshot.
 * 
 * - When a servant deletes a child on Device A, Firestore fires a 'removed' event
 *   or tombstone which purges the child from local Dexie on Device B instantly (<200ms).
 * - Also reconciles missing documents on initial/subsequent snapshots so deletions that
 *   occurred while the app was closed are removed immediately upon launch.
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

        const isMaster = currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE';
        const isStageAdmin = currentSyncKey === 'STAGE_ADMIN';
        let allowedClasses = [];
        try {
            const parsedServant = JSON.parse(currentServantStr);
            allowedClasses = parsedServant.allowedClasses || [];
        } catch (_) {}

        /**
         * Process Firestore snapshot changes and reconcile with local Dexie database
         */
        const handleSnapshot = async (snapshot, targetClassKey = null) => {
            if (!snapshot || isProcessingRef.current) return;
            isProcessingRef.current = true;

            try {
                const changes = snapshot.docChanges();
                const cloudDocIds = new Set(snapshot.docs.map(d => d.id));
                const toDeleteIds = new Set();
                const toPut = [];

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

                        let data = null;
                        if (rawData.payload) {
                            data = decryptData(rawData.payload);
                        } else {
                            data = rawData;
                        }

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
                                updatedAt: data.updatedAt || new Date().toISOString()
                            });
                        }
                    }
                }

                // 🌟 Reconciliation: Check if any clean local child in this class is missing from Firestore
                // (e.g., deleted while this device was offline/closed)
                const scopeKey = targetClassKey || (!isMaster && !isStageAdmin ? currentSyncKey : null);
                if (scopeKey) {
                    const localScopedChildren = await db.children.where('syncKey').equals(scopeKey).toArray();
                    for (const localChild of localScopedChildren) {
                        if (!localChild.isDirty && !cloudDocIds.has(String(localChild.id))) {
                            toDeleteIds.add(localChild.id);
                        }
                    }
                }

                // 🗑️ Execute local Dexie deletions for removed/deleted children
                if (toDeleteIds.size > 0) {
                    for (const delId of toDeleteIds) {
                        await safePurgeLocalChild(delId);
                        console.log(`🗑️ [RealtimeSync] Synced child deletion: ${delId}`);
                    }
                }

                // 💾 Put new/updated children into Dexie
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
                const q = collectionGroup(firestore, 'children');
                const unsub = onSnapshot(
                    q, 
                    snap => handleSnapshot(snap, null), 
                    err => console.warn('⚠️ [RealtimeSync] Master query error:', err.message)
                );
                unsubsRef.current.push(unsub);
            } else if (isStageAdmin) {
                for (const classKey of allowedClasses) {
                    const ref = collection(firestore, 'Osras', classKey, 'children');
                    const unsub = onSnapshot(
                        ref, 
                        snap => handleSnapshot(snap, classKey), 
                        err => console.warn(`⚠️ [RealtimeSync] Stage class ${classKey} error:`, err.message)
                    );
                    unsubsRef.current.push(unsub);
                }
            } else {
                const ref = collection(firestore, 'Osras', currentSyncKey, 'children');
                const unsub = onSnapshot(
                    ref, 
                    snap => handleSnapshot(snap, currentSyncKey), 
                    err => console.warn(`⚠️ [RealtimeSync] Class ${currentSyncKey} error:`, err.message)
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
