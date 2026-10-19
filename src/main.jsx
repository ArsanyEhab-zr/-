import React from 'react'
import ReactDOM from 'react-dom/client'
// 🌟 استخدمنا HashRouter عشان زرار الرجوع في الموبايل ميعملش شاشة بيضا
import { HashRouter as Router } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { registerSW } from 'virtual:pwa-register'

// 🚀 تفعيل التحديث التلقائي الفوري لـ Service Worker لمنع تقديم نسخ JS كاش قديمة
registerSW({ immediate: true });


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>,
)