import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { db } from '../db/database';
import { Download, Loader2 } from 'lucide-react';
import { ensureExcelSafeImage, sanitizeExcelRow, isValidProfilePic } from '../utils/imageUtils';
import { resolveChildClassInfo } from '../utils/nameUtils';

export default function ExcelExporter() {
    const [isExporting, setIsExporting] = useState(false);

    const handleExport = async () => {
        setIsExporting(true);
        try {
            // 1. 🔐 جلب أطفال الأسرة الحالية من قاعدة البيانات مع استبعاد المحذوفين
            const currentSyncKey = String(localStorage.getItem('currentSyncKey') || '');
            const isMaster = currentSyncKey === 'MASTER_ACCESS' || currentSyncKey === 'ADMIN_MODE';
            const currentServantObj = JSON.parse(localStorage.getItem('currentServant') || '{}');
            const allowedClasses = currentServantObj.allowedClasses || [];
            const isStageAdmin = currentSyncKey === 'STAGE_ADMIN' || currentServantObj.role === 'أمين مرحلة';

            let rawKids = [];
            if (isMaster) {
                rawKids = await db.children.toArray();
            } else if (isStageAdmin) {
                rawKids = allowedClasses.length > 0 ? await db.children.where('syncKey').anyOf(allowedClasses).toArray() : [];
            } else if (currentSyncKey) {
                rawKids = await db.children.where('syncKey').equals(currentSyncKey).toArray();
            }

            const children = rawKids.filter(c => !c.isDeleted);

            if (children.length === 0) {
                alert("لا يوجد بيانات لتصديرها!");
                setIsExporting(false);
                return;
            }

            // 2. جلب إعدادات الأسر والخدمات من الـ LocalStorage (System/mainConfig) كمصدر وحيد للحقيقة
            const appSettings = JSON.parse(localStorage.getItem('appSettings') || '{}');

            // 3. تجهيز الداتا للإكسيل مع حل الفصل حصرياً من child.syncKey وحماية الصور
            const rawExcelData = await Promise.all(children.map(async (child) => {
                // 🔍 المصدر الوحيد للحقيقة لاسم الفصل والخدمة بناءً على child.syncKey
                const classInfo = resolveChildClassInfo(child.syncKey, appSettings);
                const osraName = classInfo.osraName;
                const khedmaName = classInfo.serviceName;

                // معالجة الصورة مع حماية كاملة من المسح عند أي خطأ في فك التشفير أو الشبكة
                let safeProfilePic = "لا توجد صورة";
                if (isValidProfilePic(child.profilePic)) {
                    const processed = await ensureExcelSafeImage(child.profilePic, { id: child.id, table: 'children' });
                    safeProfilePic = isValidProfilePic(processed) ? processed : child.profilePic;
                }

                return {
                    "كود المخدوم": child.id || "لم يتم إنشاء كود",
                    "الاسم": child.name || "",
                    "كود الفصل": classInfo.syncKey || child.syncKey || "",
                    "النوع": child.gender || "",
                    "رابط الصورة المرفوعة": safeProfilePic,
                    "الخدمة التابع لها": khedmaName,
                    "الأسرة التابع لها": osraName,
                    "تليفون الأم": child.motherPhone || "",
                    "تليفون الأب": child.fatherPhone || "",
                    "تليفون المخدوم": child.childPhone || "",
                    "تليفون آخر": child.phone || "",
                    "تاريخ الميلاد": child.birthDate || "",
                    "المنطقة": child.address || "",
                    "العنوان بالتفصيل": child.detailedAddress || "",
                    "المواظبة (مرات الحضور)": child.streak || 0,
                    "آخر حضور تسبحة": child.last_tasbeha || "لم يحضر",
                    "وظيفة الأب": child.fatherJob || "",
                    "ملاحظات هامة": child.specialNotes || "",
                    "أب الاعتراف": child.fatherConfessor || "",
                    "مرسوم شماس": ((child.gender === 'boy' || child.gender === 'ولد') && child.isOrdained) ? "نعم" : "لا",
                    "الرتبة الشماسية": ((child.gender === 'boy' || child.gender === 'ولد') && child.isOrdained) ? (child.ordinationRank || "") : "",
                    "بيانات الـ QR": child.id ? `KHD:${child.id}` : "غير متوفر"
                };
            }));

            // تطهير نهائي لضمان عدم تجاوز أي نص 32,000 حرف مع الحفاظ التام على الصورة الصالحة
            const excelData = rawExcelData.map(row => sanitizeExcelRow(row, "رابط الصورة المرفوعة"));

            // 4. إنشاء ملف الإكسيل وتحميله
            const worksheet = XLSX.utils.json_to_sheet(excelData);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "بيانات المخدومين");

            const wscols = [
                { wch: 15 }, // كود المخدوم
                { wch: 30 }, // الاسم
                { wch: 18 }, // كود الفصل
                { wch: 10 }, // النوع
                { wch: 40 }, // رابط الصورة المرفوعة
                { wch: 25 }, // الخدمة التابع لها
                { wch: 25 }, // الأسرة التابع لها
                { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, // التليفونات
                { wch: 15 }, // تاريخ الميلاد
                { wch: 20 }, // المنطقة
                { wch: 40 }, // العنوان بالتفصيل
                { wch: 25 }, // المواظبة (مرات الحضور)
                { wch: 25 }, // آخر حضور تسبحة
                { wch: 20 }, // وظيفة الأب
                { wch: 40 }, // ملاحظات هامة
                { wch: 25 }, // أب الاعتراف
                { wch: 15 }, // مرسوم شماس
                { wch: 25 }, // الرتبة الشماسية
                { wch: 20 }  // بيانات الـ QR
            ];
            worksheet['!cols'] = wscols;

            XLSX.writeFile(workbook, "كشف_البيانات_الشامل.xlsx");

        } catch (err) {
            console.error("خطأ في تصدير الإكسيل:", err);
            alert("حدث خطأ أثناء استخراج البيانات!");
        }
        setIsExporting(false);
    };

    return (
        <button
            onClick={handleExport}
            disabled={isExporting}
            className="flex items-center justify-center gap-2 w-full py-4 rounded-2xl bg-emerald-50 border-2 border-emerald-200 text-emerald-700 font-black hover:bg-emerald-100 transition-all shadow-sm active:scale-95 disabled:opacity-60"
        >
            {isExporting ? <Loader2 className="animate-spin" size={20} /> : <Download size={20} />}
            {isExporting ? 'جاري تجهيز الشيت وضغط الصور...' : 'تحميل داتا النظام (Excel)'}
        </button>
    );
}
