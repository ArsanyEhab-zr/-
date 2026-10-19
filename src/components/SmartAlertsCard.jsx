import React, { useState, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import { Link } from 'react-router-dom';
import {
    AlertTriangle, Bell, MapPin, CheckCircle2, ChevronDown, ChevronUp,
    MessageCircle, ExternalLink, Filter, Calendar, Phone, Check,
    HeartHandshake, Clock, ShieldAlert
} from 'lucide-react';
import { handleImageError } from '../utils/imageUtils';

// 🛠️ دالة مساعدة لتحويل أي صيغة تاريخ أو Timestamp إلى ميلي ثانية بدقة
const parseTimestamp = (v) => {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    const num = Number(v);
    if (!isNaN(num) && num > 1000000000000) return num; // Unix ms
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
};

// 🛠️ حساب آخر 3 أيام جمعة حدثت بالفعل حتى تاريخ اليوم
const getLast3Fridays = () => {
    const fridays = [];
    const today = new Date();
    const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

    let d = new Date(today);
    for (let i = 0; i < 40 && fridays.length < 3; i++) {
        const curDateStr = new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        if (d.getDay() === 5 && curDateStr <= todayStr) {
            fridays.push(curDateStr);
        }
        d.setDate(d.getDate() - 1);
    }
    return fridays;
};

export default function SmartAlertsCard({ isMaster = false, allOsras = [], activeClassKey = '' }) {
    const [isCollapsed, setIsCollapsed] = useState(() => {
        return localStorage.getItem('smart_alerts_collapsed') === 'true';
    });
    const [filterType, setFilterType] = useState('all'); // 'all' | 'absence' | 'visitation'
    const [resolvingId, setResolvingId] = useState(null);
    const [justResolvedId, setJustResolvedId] = useState(null);

    // 🌟 ماب لأسماء الفصول للوحة الأدمن
    const osraMap = useMemo(() => {
        const map = new Map();
        for (const o of (allOsras || [])) {
            if (o.syncKey) {
                map.set(String(o.syncKey).trim(), o.name);
            }
        }
        return map;
    }, [allOsras]);

    // تحديد هل المفتاح الحالي يمثل وضع عام لكل الكنيسة/الأدمن
    const isGlobalAdminKey = !activeClassKey || 
        activeClassKey === 'MASTER_ACCESS' || 
        activeClassKey === 'ADMIN_MODE' || 
        activeClassKey === 'STAGE_ADMIN' || 
        activeClassKey === 'ALL_CHURCH' || 
        activeClassKey === 'all';

    // اسم الفصل المختار حالياً (إن وجد) للعرض الدقيق في الواجهة
    const activeClassName = useMemo(() => {
        if (!activeClassKey || isGlobalAdminKey) return null;
        return osraMap.get(String(activeClassKey).trim()) || activeClassKey;
    }, [activeClassKey, isGlobalAdminKey, osraMap]);

    // 🔄 الحساب المباشر والتفاعلي لقائمة التنبيهات مع مراقبة مباشرة لـ db.children و db.attendance
    // يضمن إعادة الحساب الفوري لأي تعديل محلي أو تغيير قادم عبر فايربيز من أجهزة الخدام الأخرى
    const alertsData = useLiveQuery(async () => {
        // 1. جلب المخدومين مباشرة من Dexie مع مراعاة الصلاحيات وفصل الخادم
        let kids = [];
        if (isMaster) {
            // إذا اختار الأدمن فصلاً محدداً من القائمة المنسدلة (مثال: 'St_Ephrem_2026')
            if (!isGlobalAdminKey) {
                kids = await db.children.where('syncKey').equals(activeClassKey).toArray();
            } else {
                // إظهار جميع المخدومين فقط إذا لم يتم اختيار فصل محدد (وضع كل الأسر)
                kids = await db.children.toArray();
                try {
                    const saved = localStorage.getItem('appSettings');
                    const settings = saved ? JSON.parse(saved) : {};
                    const allValidSyncKeys = new Set((settings.services || []).flatMap(s => s.osras || []).map(o => String(o.syncKey || '').trim()).filter(Boolean));
                    if (allValidSyncKeys.size > 0) {
                        kids = kids.filter(c => allValidSyncKeys.has(String(c.syncKey || '').trim()));
                    }
                } catch (_) {}
            }
        } else {
            // الخادم العادي: حصر القائمة في فصله فقط
            const targetKey = activeClassKey || localStorage.getItem('currentSyncKey');
            if (targetKey && targetKey !== 'MASTER_ACCESS' && targetKey !== 'ADMIN_MODE' && targetKey !== 'STAGE_ADMIN') {
                kids = await db.children.where('syncKey').equals(targetKey).toArray();
            } else {
                kids = await db.children.toArray();
            }
        }

        // 2. مراقبة جدول الحضور db.attendance
        const attendanceRecords = await db.attendance.toArray();

        // 3. حساب آخر 3 جُمع
        const fridays = getLast3Fridays();

        // 4. فهرسة الحضور والافتقاد للبحث السريع
        const attendedMap = new Map();
        const visitationMap = new Map();

        for (const rec of attendanceRecords) {
            if (!rec || rec.isDeleted || !rec.date || !rec.childId) continue;
            const cId = String(rec.childId).trim();
            const date = String(rec.date).trim();
            const recType = String(rec.type || 'service').trim().toLowerCase();

            if (recType === 'visitation') {
                if (!visitationMap.has(cId)) visitationMap.set(cId, []);
                visitationMap.get(cId).push(date);
            } else if (recType === 'service') {
                if (rec.status === 'present' || rec.status === 'attended' || !rec.status) {
                    if (!attendedMap.has(cId)) attendedMap.set(cId, new Set());
                    attendedMap.get(cId).add(date);
                }
            }
        }

        // 5. بناء قائمة التنبيهات
        const list = [];
        const nowTime = Date.now();
        const seenIds = new Set();

        for (const child of kids) {
            if (!child || child.isDeleted) continue;
            const cId = String(child.id).trim();
            if (!cId || seenIds.has(cId)) continue;
            seenIds.add(cId);

            // 🛡️ فحص التأجيل العالمي (Global Snooze): تجاهل أي مخدوم تم تأجيل تنبيهه للجميع
            if (child.alertSnoozedUntil && Number(child.alertSnoozedUntil) > nowTime) {
                continue;
            }

            // أ) فحص غياب آخر 3 جُمع متتالية
            const attendedDates = attendedMap.get(cId) || new Set();
            let lastServiceDateStr = null;
            if (child.last_service) {
                if (typeof child.last_service === 'string' && child.last_service.includes('-')) {
                    lastServiceDateStr = child.last_service.slice(0, 10);
                } else {
                    const t = parseTimestamp(child.last_service);
                    if (t > 0) lastServiceDateStr = new Date(t).toISOString().split('T')[0];
                }
            }
            const absentFridays = fridays.filter(f => !attendedDates.has(f) && lastServiceDateStr !== f);
            const hasConsecutiveAbsence = fridays.length >= 3 && absentFridays.length === fridays.length;

            // ب) فحص الافتقاد في آخر 30 يوماً
            const visitDates = visitationMap.get(cId) || [];
            const allVisitTimes = visitDates.map(parseTimestamp);
            if (child.last_visited) {
                allVisitTimes.push(parseTimestamp(child.last_visited));
            }
            allVisitTimes.sort((a, b) => b - a);
            const latestVisitTime = allVisitTimes[0] || 0;

            let hasMissingVisitation = false;
            let daysSinceVisit = null;

            if (latestVisitTime === 0) {
                hasMissingVisitation = true; // لم يتم افتقاده مطلقاً
            } else {
                daysSinceVisit = Math.max(0, Math.floor((nowTime - latestVisitTime) / (1000 * 60 * 60 * 24)));
                if (daysSinceVisit > 30) {
                    hasMissingVisitation = true;
                }
            }

            if (hasConsecutiveAbsence || hasMissingVisitation) {
                list.push({
                    child,
                    cId,
                    hasConsecutiveAbsence,
                    hasMissingVisitation,
                    absentFridays,
                    latestVisitTime,
                    daysSinceVisit,
                    priority: (hasConsecutiveAbsence && hasMissingVisitation) ? 1 : (hasConsecutiveAbsence ? 2 : 3)
                });
            }
        }

        list.sort((a, b) => a.priority - b.priority);

        return {
            alerts: list,
            last3Fridays: fridays
        };
    }, [isMaster, activeClassKey]);

    const alerts = alertsData?.alerts || [];

    const toggleCollapse = () => {
        setIsCollapsed(prev => {
            const next = !prev;
            localStorage.setItem('smart_alerts_collapsed', String(next));
            return next;
        });
    };

    // 🌟 1. تسجيل الافتقاد العالمي (Global Log Visitation)
    const handleResolveVisitation = async (child) => {
        setResolvingId(child.id);
        try {
            const now = Date.now();
            const todayStr = new Date().toISOString().split('T')[0];
            const cleanSyncKey = child.syncKey || localStorage.getItem('currentSyncKey') || '';
            const attendanceId = `${todayStr}_${child.id}_visitation`;

            // تحديث بروفايل المخدوم في Dexie مباشرة بـ Date.now()
            await db.children.update(child.id, {
                last_visited: now,
                isDirty: true,
                updatedAt: now
            });

            // تسجيل حركة الافتقاد في جدول الغياب للتاريخ والأرشيف
            await db.attendance.put({
                id: attendanceId,
                childId: child.id,
                date: todayStr,
                type: 'visitation',
                status: 'attended',
                syncKey: cleanSyncKey,
                isDirty: true,
                isDeleted: false,
                updatedAt: new Date(now).toISOString()
            });

            // إطلاق المزامنة السحابية فوراً لرفع التعديل إلى فايربيز وتحديث كل الأجهزة
            const { syncDataWithCloud } = await import('../db/sync.js');
            syncDataWithCloud();

            setJustResolvedId(child.id);
            setTimeout(() => setJustResolvedId(null), 2500);
        } catch (err) {
            console.error("Error logging visitation globally:", err);
            alert("حدث خطأ أثناء تسجيل الافتقاد: " + err.message);
        } finally {
            setResolvingId(null);
        }
    };

    // 🌟 2. تأجيل التنبيه العالمي لمدة 7 أيام (Global Snooze for 7 Days)
    const handleSnooze = async (child) => {
        setResolvingId(child.id);
        try {
            const now = Date.now();
            const snoozeUntil = now + (7 * 24 * 60 * 60 * 1000); // 7 أيام

            // تحديث alertSnoozedUntil في وثيقة المخدوم مباشرة في Dexie
            await db.children.update(child.id, {
                alertSnoozedUntil: snoozeUntil,
                isDirty: true,
                updatedAt: now
            });

            // إطلاق المزامنة السحابية فوراً لتطبيق التأجيل على كافة أجهزة الخدام والأدمن
            const { syncDataWithCloud } = await import('../db/sync.js');
            syncDataWithCloud();
        } catch (err) {
            console.error("Error snoozing alert globally:", err);
            alert("حدث خطأ أثناء تأجيل التنبيه: " + err.message);
        } finally {
            setResolvingId(null);
        }
    };

    // فلترة القائمة حسب التاب المختار
    const filteredAlerts = alerts.filter(item => {
        if (filterType === 'absence') return item.hasConsecutiveAbsence;
        if (filterType === 'visitation') return item.hasMissingVisitation;
        return true;
    });

    const absenceTotal = alerts.filter(a => a.hasConsecutiveAbsence).length;
    const visitationTotal = alerts.filter(a => a.hasMissingVisitation).length;

    // دوال مساعدة لرقم التليفون ورسالة الواتساب
    const cleanPhone = (phone) => {
        if (!phone) return "";
        let clean = String(phone).replace(/[^0-9]/g, '');
        if (clean.startsWith('01')) clean = '2' + clean;
        return clean;
    };

    const getTargetPhone = (c) => {
        if (c.whatsappTarget === 'child' && c.childPhone) return c.childPhone;
        if (c.whatsappTarget === 'father' && c.fatherPhone) return c.fatherPhone;
        if (c.whatsappTarget === 'mother' && c.motherPhone) return c.motherPhone;
        return c.motherPhone || c.fatherPhone || c.childPhone || c.phone || '';
    };

    const getWhatsAppLink = (c, item) => {
        const raw = getTargetPhone(c);
        const cleaned = cleanPhone(raw);
        if (!cleaned) return null;
        const namePart = c.name ? c.name.split(' ').slice(0, 2).join(' ') : 'المخدوم';
        let text = `سلام ونعمة يا فندم، بنطمن على البطل ${namePart} في خدمة مدارس الأحد ❤️✝️`;
        if (item.hasConsecutiveAbsence) {
            text = `سلام ونعمة يا فندم، مفتقدين البطل ${namePart} جداً في مدارس الأحد، وحابين نطمن عليه لعدم حضوره الجمع السابقة 🌟`;
        }
        return `https://api.whatsapp.com/send?phone=${cleaned}&text=${encodeURIComponent(text)}`;
    };

    return (
        <section className="mb-6 animate-in fade-in slide-in-from-top-3 duration-300 font-sans" dir="rtl">
            <div className="bg-linear-to-br from-amber-500/10 via-rose-500/5 to-indigo-500/10 backdrop-blur-md rounded-[2.5rem] p-5 border-2 border-amber-200/70 shadow-lg relative overflow-hidden">
                
                {/* 🌟 هيدر الكارت القابل للطي */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-amber-200/50">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-linear-to-br from-amber-500 to-rose-500 text-white flex items-center justify-center shadow-md shadow-amber-500/30 shrink-0 relative">
                            <Bell className="w-6 h-6 animate-bounce" />
                            {alerts.length > 0 && (
                                <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center border-2 border-white shadow-sm">
                                    {alerts.length}
                                </span>
                            )}
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-base font-black text-slate-800">التنبيهات الذكية والمتابعة الفورية</h2>
                                {activeClassName ? (
                                    <span className="bg-indigo-100 text-indigo-700 text-[10px] font-black px-2 py-0.5 rounded-full">
                                        {activeClassName}
                                    </span>
                                ) : isMaster ? (
                                    <span className="bg-purple-100 text-purple-700 text-[10px] font-black px-2 py-0.5 rounded-full">
                                        كل الأسر (عام)
                                    </span>
                                ) : null}
                            </div>
                            <p className="text-xs font-bold text-slate-500 mt-0.5">
                                {alerts.length > 0 
                                    ? `يوجد ${alerts.length} مخدوم بحاجة لافتقاد أو متابعة غياب عاجلة${activeClassName ? ` في ${activeClassName}` : ''}`
                                    : `جميع المخدومين${activeClassName ? ` في ${activeClassName}` : ''} في حالة افتقاد وحضور ممتازة 🌟`}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-auto">
                        <button
                            onClick={toggleCollapse}
                            aria-label={isCollapsed ? "عرض التنبيهات" : "طي التنبيهات"}
                            className="flex items-center gap-1.5 px-3.5 py-2 bg-white/90 hover:bg-white text-slate-700 rounded-xl font-black text-xs border border-amber-200/70 shadow-sm transition-all cursor-pointer"
                        >
                            <span>{isCollapsed ? 'عرض التنبيهات' : 'طي الكارت'}</span>
                            {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                        </button>
                    </div>
                </div>

                {/* 🌟 محتوى التنبيهات القابل للتمدد */}
                {!isCollapsed && (
                    <div className="mt-4 space-y-4 animate-in fade-in duration-200">
                        {/* أزرار الفلترة السريعة */}
                        {alerts.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    onClick={() => setFilterType('all')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all cursor-pointer ${
                                        filterType === 'all'
                                            ? 'bg-slate-900 text-white shadow-sm'
                                            : 'bg-white/80 text-slate-600 hover:bg-white'
                                    }`}
                                >
                                    الكل ({alerts.length})
                                </button>
                                <button
                                    onClick={() => setFilterType('absence')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1 cursor-pointer ${
                                        filterType === 'absence'
                                            ? 'bg-rose-600 text-white shadow-sm'
                                            : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                                    }`}
                                >
                                    <span>🚨 غياب متكرر ({absenceTotal})</span>
                                </button>
                                <button
                                    onClick={() => setFilterType('visitation')}
                                    className={`px-3 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1 cursor-pointer ${
                                        filterType === 'visitation'
                                            ? 'bg-amber-600 text-white shadow-sm'
                                            : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                                    }`}
                                >
                                    <span>🏡 يحتاج افتقاد ({visitationTotal})</span>
                                </button>
                            </div>
                        )}

                        {/* حالة عدم وجود أي تنبيهات */}
                        {alerts.length === 0 && (
                            <div className="bg-white/90 rounded-2xl p-6 text-center border border-emerald-100 shadow-sm">
                                <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-2">
                                    <CheckCircle2 size={24} />
                                </div>
                                <h3 className="text-sm font-black text-emerald-900">ممتاز! لا توجد تنبيهات نشطة</h3>
                                <p className="text-xs font-bold text-emerald-700 mt-1">
                                    جميع المخدومين يواظبون على الحضور وتلقوا افتقاداً خلال آخر 30 يوماً.
                                </p>
                            </div>
                        )}

                        {/* قائمة التنبيهات الفعلية */}
                        <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                            {filteredAlerts.map(item => {
                                const { child, hasConsecutiveAbsence, hasMissingVisitation, absentFridays, daysSinceVisit, latestVisitTime } = item;
                                const isResolving = resolvingId === child.id;
                                const isJustResolved = justResolvedId === child.id;
                                const whatsAppLink = getWhatsAppLink(child, item);
                                const className = isMaster ? osraMap.get(String(child.syncKey).trim()) : null;

                                return (
                                    <div
                                        key={child.id}
                                        className={`p-4 rounded-2xl border transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs ${
                                            hasConsecutiveAbsence && hasMissingVisitation
                                                ? 'bg-rose-50/90 border-rose-200'
                                                : hasConsecutiveAbsence
                                                    ? 'bg-rose-50/70 border-rose-200'
                                                    : 'bg-amber-50/70 border-amber-200'
                                        }`}
                                    >
                                        {/* بيانات المخدوم وسبب التنبيه */}
                                        <div className="flex items-start gap-3">
                                            <div className="w-12 h-12 rounded-full overflow-hidden bg-white border-2 border-slate-200 shrink-0 shadow-sm flex items-center justify-center text-lg">
                                                {child.profilePic ? (
                                                    <img
                                                        src={child.profilePic}
                                                        alt={child.name}
                                                        width="48"
                                                        height="48"
                                                        onError={handleImageError}
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    child.gender === 'بنت' ? '👧' : '👦'
                                                )}
                                            </div>

                                            <div className="space-y-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Link
                                                        to={`/child/${child.id}`}
                                                        className="font-black text-sm text-slate-800 hover:text-indigo-600 transition-colors flex items-center gap-1"
                                                    >
                                                        {child.name}
                                                        <ExternalLink size={12} className="text-slate-400" />
                                                    </Link>
                                                    {className && (
                                                        <span className="bg-slate-200/80 text-slate-700 text-[10px] font-black px-2 py-0.5 rounded-md">
                                                            {className}
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    {hasConsecutiveAbsence && (
                                                        <span className="bg-rose-100 text-rose-800 border border-rose-200 px-2 py-0.5 rounded-md text-[11px] font-black flex items-center gap-1">
                                                            <AlertTriangle size={12} className="text-rose-600" />
                                                            غائب آخر 3 جُمع ({absentFridays.map(f => f.slice(5)).join(' ، ')})
                                                        </span>
                                                    )}

                                                    {hasMissingVisitation && (
                                                        <span className="bg-amber-100 text-amber-900 border border-amber-200 px-2 py-0.5 rounded-md text-[11px] font-bold flex items-center gap-1">
                                                            <MapPin size={12} className="text-amber-700" />
                                                            {daysSinceVisit !== null
                                                                ? `لم يُفتقد منذ ${daysSinceVisit} يوم`
                                                                : 'لم يتم تسجيل افتقاد بعد'}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        {/* أزرار الإجراءات الفورية */}
                                        <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                                            {/* 🟢 زر تسجيل الافتقاد وحل التنبيه للجميع */}
                                            <button
                                                onClick={() => handleResolveVisitation(child)}
                                                disabled={isResolving}
                                                className={`px-3 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 shadow-xs cursor-pointer ${
                                                    isJustResolved
                                                        ? 'bg-emerald-600 text-white'
                                                        : 'bg-emerald-500 hover:bg-emerald-600 text-white active:scale-95'
                                                }`}
                                            >
                                                {isJustResolved ? (
                                                    <>
                                                        <Check size={14} /> تم الافتقاد وحل التنبيه!
                                                    </>
                                                ) : (
                                                    <>
                                                        <HeartHandshake size={14} /> تسجيل افتقاد
                                                    </>
                                                )}
                                            </button>

                                            {/* ⏱️ زر التأجيل العالمي 7 أيام لكل الخدام */}
                                            <button
                                                onClick={() => handleSnooze(child)}
                                                disabled={isResolving}
                                                className="px-2.5 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 flex items-center gap-1 text-xs font-bold transition-colors cursor-pointer shadow-xs"
                                                title="تأجيل هذا التنبيه لمدة 7 أيام لكل الخدام والأدمن"
                                            >
                                                <Clock size={14} className="text-amber-600" />
                                                <span className="hidden sm:inline">تأجيل 7 أيام</span>
                                            </button>

                                            {/* زر الواتساب للتواصل المباشر */}
                                            {whatsAppLink && (
                                                <a
                                                    href={whatsAppLink}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="w-9 h-9 rounded-xl bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 flex items-center justify-center transition-colors shadow-xs"
                                                    title="مراسلة ولي الأمر على واتساب"
                                                >
                                                    <MessageCircle size={16} />
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
