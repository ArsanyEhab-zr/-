import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * 🌐 useNetworkStatus — Global hook for online/offline detection + auto-sync on reconnect & visibility.
 * Mount once at App level. Automatically triggers silent background sync:
 * 1. Immediately when the browser fires the 'online' event.
 * 2. On app mount when internet connectivity is active.
 * 3. When the tab or app regains focus or visibility ('visibilitychange' to 'visible').
 * 4. Periodically every 90 seconds while online and visible.
 */
export default function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    const isSyncingRef = useRef(false);

    const runBackgroundSync = useCallback(async () => {
        if (!navigator.onLine) return;
        if (isSyncingRef.current) return; // Prevent concurrent syncs
        isSyncingRef.current = true;
        try {
            // Dynamic import to avoid circular dependencies and reduce initial bundle
            const { syncDataWithCloud } = await import('../db/sync.js');
            const result = await syncDataWithCloud();
            console.log('🔄 [AutoSync] Background sync completed:', result.success ? '✅' : '❌', result.message?.slice(0, 80));
        } catch (err) {
            console.warn('🔄 [AutoSync] Background sync failed silently:', err.message);
        } finally {
            isSyncingRef.current = false;
        }
    }, []);

    useEffect(() => {
        const handleOnline = () => {
            setIsOnline(true);
            console.log('🟢 [Network] Back online — triggering background sync...');
            runBackgroundSync();
        };

        const handleOffline = () => {
            setIsOnline(false);
            console.log('🟠 [Network] Gone offline — working locally.');
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && navigator.onLine) {
                console.log('👁️ [Network] App tab became visible — triggering background sync...');
                runBackgroundSync();
            }
        };

        const handleFocus = () => {
            if (navigator.onLine) {
                runBackgroundSync();
            }
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleFocus);

        // Initial sync on mount if online
        if (navigator.onLine) {
            runBackgroundSync();
        }

        // Periodic background sync interval (every 90s)
        const intervalId = setInterval(() => {
            if (navigator.onLine && document.visibilityState === 'visible') {
                runBackgroundSync();
            }
        }, 90000);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleFocus);
            clearInterval(intervalId);
        };
    }, [runBackgroundSync]);

    return { isOnline, triggerSyncNow: runBackgroundSync };
}
