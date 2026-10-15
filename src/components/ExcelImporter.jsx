import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { db } from '../db/database';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';

import useAutoSync from '../hooks/useAutoSync';
import { generateChildId, isCleanChildId, ensureCleanChildId } from '../utils/idGenerator';

export default function ExcelImporter() {
    const [isImporting, setIsImporting] = useState(false);
    const { triggerAutoSync } = useAutoSync();

    // 🧠 المُترجم الذكي للتواريخ العربية والإنجليزية
    const parseArabicDate = (dateString) => {
        if (!dateString) return { bMonth: null, bDay: null };
        const str = String(dateString).trim();

        const arabicMonths = {
            "يناير": 1, "فبراير": 2, "مارس": 3, "ابريل": 4, "إبريل": 4,
            "مايو": 5, "يونيو": 6, "يونيه": 6, "يوليو": 7, "يوليه": 7,
            "اغسطس": 8, "أغسطس": 8, "سبتمبر": 9, "اكتوبر": 10, "أكتوبر": 10,
            "نوفمبر": 11, "ديسمبر": 12
        };

        let bMonth = null;
        let bDay = null;

        // 1. محاولة استخراج الشهر المكتوب بالعربي
        for (const [monthName, monthNum] of Object.entries(arabicMonths)) {
            if (str.includes(monthName)) {
                bMonth = monthNum;
                // استخراج اليوم (أول رقم موجود في النص)
                const match = str.match(/\d{1,2}/);
                if (match) {
                    bDay = parseInt(match[0], 10);
                }
                break;
            }
        }

        // 2. لو مفيش شهر عربي، نحاول نقرأ التواريخ الرقمية (زي 25/11/2014 أو 28-7-2016)
        if (!bMonth) {
            const parts = str.split(/[-/]/);
            if (parts.length >= 2) {
                const p1 = parseInt(parts[0], 10);
                const p2 = parseInt(parts[1], 10);

                // بنفترض إن التنسيق يوم/شهر
                if (p2 >= 1 && p2 <= 12 && p1 >= 1 && p1 <= 31) {
                    bDay = p1;
                    bMonth = p2;
                } else if (p1 >= 1 && p1 <= 12 && p2 >= 1 && p2 <= 31) {
                    bMonth = p1;
                    bDay = p2;
                }
            }
        }

        return { bMonth, bDay };
    };


    const handleFileUpload = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsImporting(true);

        const reader = new FileReader();

        reader.onload = async (event) => {
            try {
                const data = new Uint8Array(event.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames?.[0];
                if (!sheetName || !workbook.Sheets[sheetName]) {
                    alert("الملف فارغ أو لا يحتوي على أي شيتات صالحة!");
                    setIsImporting(false);
                    return;
                }

                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet);

                if (!jsonData || jsonData.length === 0) {
                    alert("لا توجد بيانات في شيت الإكسيل المرفوع!");
                    setIsImporting(false);
                    return;
                }

                const existingChildren = await db.children.toArray();
                const syncKey = localStorage.getItem('currentSyncKey');
                const now = new Date().toISOString();

                // فلترة الصفوف الفارغة وتعقيم البيانات وإسناد Primary Key صالح ومؤكد
                const sanitizedRows = [];
                const trimStr = (val) => (val !== null && val !== undefined ? String(val).trim() : "");

                for (let idx = 0; idx < jsonData.length; idx++) {
                    const row = jsonData[idx];
                    const excelRowNum = idx + 2; // +2 لأن رأس الجدول في الإكسيل هو السطر 1

                    if (!row || typeof row !== 'object') continue;

                    // استبعاد الصفوف الفارغة تماماً
                    const hasNonEmptyValue = Object.values(row).some(
                        v => v !== null && v !== undefined && String(v).trim() !== ''
                    );
                    if (!hasNonEmptyValue) continue;

                    const rawName = row["name"] || row["الاسم"];
                    const name = trimStr(rawName);

                    // استبعاد الصفوف التي تفتقر للاسم الأساسي
                    if (!name) continue;

                    // استخراج الـ ID الأصلي أو الكود إن كان نظيفاً ومطابقاً للنمط، وإلا تركه لتوليد ID مهيكل نظيف
                    const rawId = trimStr(
                        row["id"] || 
                        row["ID"] || 
                        row["code"] || 
                        row["Code"] || 
                        row["كود"] || 
                        row["كود المخدوم"]
                    );

                    const primaryKey = isCleanChildId(rawId) ? rawId : null;

                    const rawBirthDate = trimStr(row["birthDate"] || row["تاريخ الميلاد"]);
                    const { bMonth, bDay } = parseArabicDate(rawBirthDate);

                    const genderRaw = trimStr(row["gender"] || row["النوع"]).toLowerCase();
                    const gender = (genderRaw === "بنت" || genderRaw === "girl" || genderRaw === "female") ? "بنت" : "ولد";

                    sanitizedRows.push({
                        excelRowNum,
                        childData: {
                            id: primaryKey,
                            name,
                            syncKey: syncKey || "",
                            phone: trimStr(row["phone"] || row["تليفون آخر"] || row["تليفون"] || row["الهاتف"]),
                            childPhone: trimStr(row["childPhone"] || row["تليفون المخدوم"]),
                            motherPhone: trimStr(row["motherPhone"] || row["تليفون الأم"]),
                            fatherPhone: trimStr(row["fatherPhone"] || row["تليفون الأب"]),
                            whatsappTarget: trimStr(row["whatsappTarget"]) || "mother",
                            gender,
                            address: trimStr(row["address"] || row["المنطقة"]),
                            detailedAddress: trimStr(row["detailedAddress"] || row["العنوان"]),
                            gpsLink: trimStr(row["gpsLink"] || row["موقع البيت"]),
                            profilePic: trimStr(row["profilePic"] || row["رابط الصورة المرفوعة"]),
                            birthDate: rawBirthDate,
                            birthMonth: bMonth,
                            birthDay: bDay,
                            fatherJob: trimStr(row["fatherJob"] || row["وظيفة الأب"]),
                            specialNotes: trimStr(row["specialNotes"] || row["ملاحظات"]),
                            fatherConfessor: trimStr(row["fatherConfessor"] || row["أب الاعتراف"]),
                            isOrdained: row["isOrdained"] === true || String(row["isOrdained"]).toUpperCase() === "TRUE" || trimStr(row["مرسوم شماس"]) === "نعم",
                            ordinationRank: trimStr(row["ordinationRank"] || row["الرتبة الشماسية"]),
                            streak: Number(row["المواظبة"] || row["streak"] || 0) || 0,
                            last_liturgy: null,
                            last_service: null,
                            last_tasbeha: trimStr(row["last_tasbeha"] || row["آخر حضور تسبحة"]) || null,
                            last_visited: null,
                            last_birthday_gift: null,
                            last_reward_date: null,
                            isBrother: false,
                            gotClothes: false,
                            isDirty: true,
                            updatedAt: now,
                            isDeleted: false,
                            massAttendance: 0,
                            preparation: "",
                            serviceMeetingAttendance: 0,
                            visitationParticipation: 0,
                            lastConfessionDate: null,
                            activityParticipation: "",
                            medicalStatus: trimStr(row["medicalStatus"] || row["الحالة الصحية"])
                        }
                    });
                }

                if (sanitizedRows.length === 0) {
                    alert("لم يتم العثور على أي صفوف صالحة للاستيراد في الملف (تأكد من وجود عمود 'الاسم' أو 'name').");
                    setIsImporting(false);
                    return;
                }

                let successCount = 0;
                const errorRows = [];

                const existingIds = new Set(existingChildren.map(c => c.id).filter(Boolean));

                for (const { excelRowNum, childData } of sanitizedRows) {
                    try {
                        const existingChild = existingChildren.find(c => 
                            (childData.id && c.id === childData.id) || 
                            (c.name && childData.name && c.name.trim() === childData.name.trim())
                        );

                        if (existingChild) {
                            const finalId = ensureCleanChildId(existingChild.id, childData.gender, undefined, existingIds);
                            const updated = { 
                                ...existingChild, 
                                ...childData, 
                                profilePic: childData.profilePic || existingChild.profilePic || "",
                                streak: childData.streak || existingChild.streak || 0,
                                last_liturgy: existingChild.last_liturgy || null,
                                last_service: existingChild.last_service || null,
                                last_tasbeha: childData.last_tasbeha || existingChild.last_tasbeha || null,
                                last_visited: existingChild.last_visited || null,
                                id: finalId, 
                                isDeleted: false 
                            };
                            if (existingChild.id !== finalId) {
                                await db.children.delete(existingChild.id);
                            }
                            await db.children.put(updated);
                            Object.assign(existingChild, updated);
                        } else {
                            const finalId = ensureCleanChildId(childData.id, childData.gender, undefined, existingIds);
                            childData.id = finalId;
                            existingIds.add(finalId);
                            await db.children.add(childData);
                            existingChildren.push({ ...childData });
                        }
                        successCount++;
                    } catch (rowErr) {
                        console.error(`خطأ في استيراد السطر ${excelRowNum} (${childData.name}):`, rowErr);
                        errorRows.push({
                            row: excelRowNum,
                            name: childData.name,
                            error: rowErr?.message || "خطأ غير معروف"
                        });
                    }
                }

                if (successCount > 0) {
                    triggerAutoSync();
                }

                if (errorRows.length > 0) {
                    const sampleErrors = errorRows.slice(0, 5).map(e => `سطر ${e.row} (${e.name}): ${e.error}`).join('\n');
                    const remainingNotice = errorRows.length > 5 ? `\n... و ${errorRows.length - 5} صفوف أخرى.` : '';
                    alert(`تم استيراد وتحديث ${successCount} مخدوم بنجاح! ⚠️\nتم تخطي ${errorRows.length} صف بسبب أخطاء:\n${sampleErrors}${remainingNotice}`);
                } else {
                    alert(`مبروك! تم استيراد وتحديث ${successCount} مخدوم بنجاح (بما فيها أعياد الميلاد)! 🎉`);
                }

                if (successCount > 0) {
                    window.location.reload();
                }
            } catch (err) {
                console.error(err);
                alert("حصلت مشكلة أثناء قراءة الملف! اتأكد من صحة البيانات.");
            } finally {
                setIsImporting(false);
                if (e.target) {
                    e.target.value = '';
                }
            }
        };

        reader.readAsArrayBuffer(file);
    };

    return (
        <label className={`flex items-center justify-center gap-3 w-full py-4 rounded-2xl border-2 border-dashed cursor-pointer transition-all ${isImporting ? 'bg-slate-100 border-slate-300' : 'bg-indigo-50 border-indigo-200 hover:bg-indigo-100'}`}>
            {isImporting ? <Loader2 className="animate-spin text-indigo-600" size={20} /> : <Upload className="text-indigo-600" size={20} />}
            <span className="text-sm font-black text-indigo-700">
                {isImporting ? 'جاري معالجة البيانات والأعياد...' : 'رفع شيت المخدومين (Excel)'}
            </span>
            <input type="file" accept=".xlsx, .xls, .csv" className="hidden" onChange={handleFileUpload} disabled={isImporting} />
        </label>
    );
}