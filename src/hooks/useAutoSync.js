import { useRef, useCallback } from 'react';

/**
 * 🚀 useAutoSync — Smart write trigger hook.
 * After any local Dexie write, call triggerAutoSync() to schedule a debounced background push.
 * Also provides triggerAutoSyncImmediate() to push immediately without debounce.
 * Only fires if the device is online. Silent — no alerts, no UI interruption.
 */
export default function useAutoSync(debounceMs = 2500) {
    const timerRef = useRef(null);
    const isSyncingRef = useRef(false);

    const performSync = useCallback(async () => {
        if (!navigator.onLine) return;
        if (isSyncingRef.current) return;
        isSyncingRef.current = true;
        try {
            const { syncDataWithCloud } = await import('../db/sync.js');
            const result = await syncDataWithCloud();
            console.log('⚡ [SmartSync] Background push completed:', result.success ? '✅' : '❌');
        } catch (err) {
            console.warn('⚡ [SmartSync] Background push failed silently:', err?.message);
        } finally {
            isSyncingRef.current = false;
        }
    }, []);

    const triggerAutoSync = useCallback(() => {
        if (!navigator.onLine) return;

        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }

        timerRef.current = setTimeout(() => {
            performSync();
        }, debounceMs);
    }, [debounceMs, performSync]);

    const triggerAutoSyncImmediate = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        performSync();
    }, [performSync]);

    return { triggerAutoSync, triggerAutoSyncImmediate };
}
