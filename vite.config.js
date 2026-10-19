import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite'; // 👈 ده السطر اللي كان ناقص وطير التصميم!
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    tailwindcss(), // 👈 تشغيل التصميم
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['image/osra.png', 'image/khedma.png', 'favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'مَدْرَسَةُ كِينُونْيَا لِلشَّمَامِسَةِ وَالأَلْحَانِ',
        short_name: 'Ⲕⲟⲓⲛⲱⲛⲓⲁ',
        start_url: '/',
        description: 'تطبيق إدارة الحضور والغياب لخدمة مدارس الأحد',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        dir: 'rtl',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          }
        ]
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,jpg,jpeg,woff2}'],
        runtimeCaching: [
          {
            // Cache remote Cloudinary images with CacheFirst strategy for 100% offline access
            urlPattern: /^https:\/\/res\.cloudinary\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cloudinary-images',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Cache other remote image CDNs (Firebase Storage, Google User Content, Avatars)
            urlPattern: /^https:\/\/(?:firebasestorage\.googleapis\.com|lh3\.googleusercontent\.com|api\.dicebear\.com)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'remote-images-cache',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 90 * 24 * 60 * 60 // 90 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Cache local and static images
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'static-images-cache',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 60 * 24 * 60 * 60 // 60 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Cache Google Fonts stylesheets and webfonts
            urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 365 * 24 * 60 * 60 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    })
  ]
});