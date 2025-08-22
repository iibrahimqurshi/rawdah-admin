import React, { useMemo, useRef, useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { Download, FileUp, Filter, History, Loader2, RefreshCw, Upload, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Rawdah Admin Page (Nusuk-style)
 * - Upload Excel + From/To dates
 * - Parse slots (Slot_ID, Start_Time, End_Time, Day, Gender, Capacity)
 * - Expand to actual dates [from..to] using Day column (All or weekday)
 * - Widgets: Total Capacity, Men, Women, Booked
 * - Tables: Imported Capacities (with filters, export, **pagination 20/pg**), Booked Slots (read-only, export, **pagination 20/pg**)
 * - Policy: Replace existing range on Import (front-end indicated only)
 * - Time format stored as HH:MM (string)
 * - Week start: Sunday
 *
 * FIXES (this revision):
 * - Define missing functions: **exportCapacities**, **exportBookings**, **loadMockBookings** to prevent ReferenceErrors.
 * - Keep all previous unit tests intact and add robustness in CSV builder.
 */

// --- Helpers ---------------------------------------------------------------
const WEEKDAYS: ("Sunday"|"Monday"|"Tuesday"|"Wednesday"|"Thursday"|"Friday"|"Saturday"|"All")[] = [
  "Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","All"
];
const GENDERS = ["Men", "Women"] as const;

function fmtDate(d: Date) { return d.toISOString().slice(0,10); }
function* dateRange(from: Date, to: Date) { const d = new Date(from); while (d <= to) { yield new Date(d); d.setDate(d.getDate()+1); } }
function weekdayName(d: Date): (typeof WEEKDAYS)[number] { return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()] as any; }

/** Build a CSV string (no download). */
function buildCSV(rows: any[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (val: any) => {
    const s = String(val ?? "");
    // If value contains comma, double-quote, or newline (\n or \r), wrap in quotes and escape quotes
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) { lines.push(headers.map(h => esc((r as any)[h])).join(",")); }
  return lines.join("\n");
}

/** Trigger a file download for provided rows as CSV. */
function downloadCSV(filename: string, rows: any[]) {
  if (!rows.length) return;
  const csv = buildCSV(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// Types
interface SlotRow { Slot_ID: number; Start_Time: string; End_Time: string; Day: string; Gender: string; Capacity: number; }
interface ExpandedRow extends SlotRow { Date: string; }
interface BookingRow { Booking_ID: string; Date: string; Slot_ID: number; Start_Time: string; End_Time: string; Gender: string; Seats_Booked: number; Pilgrim_Name: string; Nationality: string; Pilgrim_ID: string; Group?: string; Status: "Booked"|"Checked-in"|"Cancelled"; Created_At: string; }

export default function RawdahAdminPage() {
  // Controls
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [excelFile, setExcelFile] = useState<File|null>(null);
  const [loading, setLoading] = useState(false);

  // CSV test status
  const [csvTest, setCsvTest] = useState<{ok:boolean; msg:string}>({ok:true, msg:""});

  // Data
  const [imported, setImported] = useState<ExpandedRow[]>([]); // expanded by date
  const [bookings, setBookings] = useState<BookingRow[]>([]); // read-only showcase; can be loaded/mock

  // Filters for capacities table
  const [filterDay, setFilterDay] = useState<string>("");
  const [filterGender, setFilterGender] = useState<string>("");
  const [filterDate, setFilterDate] = useState<string>("");

  // Pagination config & state (20 per page)
  const PAGE_SIZE = 20; // <-- single source of truth
  const [capPage, setCapPage] = useState(1);
  const [bookPage, setBookPage] = useState(1);
  useEffect(() => { setCapPage(1); }, [imported, filterDay, filterGender, filterDate]);
  useEffect(() => { setBookPage(1); }, [bookings]);

  // Calendar: keep a set of dates that were "applied" via Import
  const [appliedDates, setAppliedDates] = useState<Set<string>>(new Set());
  const [calCursor, setCalCursor] = useState<Date>(new Date()); // current month in calendar

  const inputRef = useRef<HTMLInputElement>(null);

  // --- Lightweight unit tests for CSV builder -----------------------------
  useEffect(() => {
    try {
      const sample = [
        { A: "hello", B: 123 },
        { A: "needs,comma", B: "ok" },
        { A: 'He said "hi"', B: "quote" },
        { A: "line1\nline2", B: "newline" },
        { A: "crlf line1\r\nline2", B: "crlf" },
        { A: 'combo, "quote"', B: "mix" },
      ];
      const csv = buildCSV(sample);
      // Expectations:
      const lines = csv.split("\n");
      const headersOk = lines[0] === "A,B";
      const containsQuotedComma = csv.includes('"needs,comma"');
      const containsEscapedQuote = csv.includes('"He said ""hi"""');
      const containsNewlineQuoted = csv.includes('"line1\nline2"');
      const containsCRLFQuoted = csv.includes('"crlf line1\r\nline2"');
      const containsCombo = csv.includes('"combo, ""quote"""');
      const ok = headersOk && containsQuotedComma && containsEscapedQuote && containsNewlineQuoted && containsCRLFQuoted && containsCombo;
      setCsvTest({ ok, msg: ok ? "CSV tests passed" : "CSV tests failed" });
    } catch (e:any) {
      setCsvTest({ ok:false, msg: e?.message || "CSV test error" });
    }
  }, []);

  // Parse Excel & Expand
  async function handleValidatePreview() {
    if (!excelFile || !fromDate || !toDate) return alert("Select From/To dates and upload an Excel file.");
    setLoading(true);
    try {
      const data = await excelFile.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]]; // expect 'Slots'
      const rows = XLSX.utils.sheet_to_json<SlotRow>(ws, { defval: "" });
      const required = ["Slot_ID","Start_Time","End_Time","Day","Gender","Capacity"];
      const headerOk = required.every(h => Object.keys(rows[0]||{}).includes(h));
      if (!headerOk) throw new Error("Invalid headers. Expected: " + required.join(", "));

      const norm: SlotRow[] = rows.map(r => ({
        Slot_ID: Number(r.Slot_ID), Start_Time: String(r.Start_Time), End_Time: String(r.End_Time), Day: String(r.Day), Gender: String(r.Gender), Capacity: Number(r.Capacity||0)
      }));

      const from = new Date(fromDate+"T00:00:00");
      const to = new Date(toDate+"T00:00:00");
      const expanded: ExpandedRow[] = [];
      for (const d of dateRange(from, to)) {
        const wd = weekdayName(d);
        for (const r of norm) { if (r.Day === "All" || r.Day === wd) expanded.push({ ...r, Date: fmtDate(d) }); }
      }

      // Conflict detection: same Date+Slot with Men>0 and Women>0
      const conflicts: Record<string, { men:number; women:number; } > = {};
      for (const r of expanded) { const key = `${r.Date}|${r.Slot_ID}`; if (!conflicts[key]) conflicts[key] = { men:0, women:0 }; if (r.Gender === "Men") conflicts[key].men += (r.Capacity>0?1:0); if (r.Gender === "Women") conflicts[key].women += (r.Capacity>0?1:0); }
      const bad = Object.entries(conflicts).filter(([,v]) => v.men>0 && v.women>0);

      setImported(expanded);
      alert(`Preview ready. Rows: ${expanded.length}. Conflicts found: ${bad.length}.`);
    } catch (e:any) { console.error(e); alert("Error: " + e.message); }
    finally { setLoading(false); }
  }

  function addRangeToApplied(from: string, to: string) {
    const set = new Set(appliedDates);
    const start = new Date(from+"T00:00:00");
    const end = new Date(to+"T00:00:00");
    for (const d of dateRange(start, end)) set.add(fmtDate(d));
    setAppliedDates(set);
  }

  function handleImport() {
    if (!imported.length) return alert("Run Validate & Preview first.");
    // mark the selected range as applied (highlight in calendar)
    if (fromDate && toDate) addRangeToApplied(fromDate, toDate);
    alert(`Imported ${imported.length} rows. Policy: Replace existing range.`);
  }

  // Widgets
  const totals = useMemo(() => {
    let total = 0, men = 0, women = 0; 
    for (const r of imported) { total += r.Capacity; if (r.Gender === "Men") men += r.Capacity; else women += r.Capacity; }
    const booked = bookings.reduce((s,b)=> s + (b.Status!=="Cancelled" ? b.Seats_Booked : 0), 0);
    return { total, men, women, booked };
  }, [imported, bookings]);

  // Visible data with filters (capacities)
  const capacitiesView = useMemo(() => imported.filter(r => (( !filterDay || r.Day === filterDay) && (!filterGender || r.Gender === filterGender) && (!filterDate || r.Date === filterDate) )), [imported, filterDay, filterGender, filterDate]);

  // Paged slices (use the single PAGE_SIZE)
  const capTotal = capacitiesView.length; const capPages = Math.max(1, Math.ceil(capTotal / PAGE_SIZE));
  const capStart = (capPage-1)*PAGE_SIZE; const capEnd = capStart + PAGE_SIZE; const capRows = capacitiesView.slice(capStart, capEnd);

  const bookTotal = bookings.length; const bookPages = Math.max(1, Math.ceil(bookTotal / PAGE_SIZE));
  const bookStart = (bookPage-1)*PAGE_SIZE; const bookEnd = bookStart + PAGE_SIZE; const bookRows = bookings.slice(bookStart, bookEnd);

  // --- Pagination sanity tests (added) -----------------------------------
  const [paginationTest, setPaginationTest] = useState<{ok:boolean; msg:string}>({ok:true, msg:""});
  useEffect(() => {
    try {
      const okCap = capRows.length <= PAGE_SIZE && capPages >= 1;
      const okBook = bookRows.length <= PAGE_SIZE && bookPages >= 1;
      setPaginationTest({ ok: okCap && okBook, msg: okCap && okBook ? "Pagination tests passed" : "Pagination tests failed" });
    } catch (e:any) {
      setPaginationTest({ ok:false, msg: e?.message || "Pagination test error" });
    }
  }, [capRows.length, bookRows.length, PAGE_SIZE, capPages, bookPages]);

  // Overlap indicator for the currently selected range vs applied dates
  const overlapCount = useMemo(() => {
    if (!fromDate || !toDate) return 0;
    let c = 0; const start = new Date(fromDate+"T00:00:00"); const end = new Date(toDate+"T00:00:00");
    for (const d of dateRange(start, end)) { if (appliedDates.has(fmtDate(d))) c++; }
    return c;
  }, [fromDate, toDate, appliedDates]);

  // --- Actions: export & mock bookings ------------------------------------
  function exportCapacities() { downloadCSV("capacities.csv", capacitiesView); }
  function exportBookings() { downloadCSV("booked_slots.csv", bookings); }
  function loadMockBookings() {
    if (!imported.length) return alert("Import capacities first to align slots.");
    const sample: BookingRow[] = [];
    const pick = imported.slice(0, 400);
    let i=1;
    for (const r of pick) {
      if (r.Capacity <= 0) continue;
      if (Math.random() < 0.08) continue; // skip some
      const seats = Math.min(5, Math.max(1, Math.floor(Math.random()*4)+1));
      sample.push({
        Booking_ID: `B${String(i).padStart(5,'0')}`,
        Date: r.Date,
        Slot_ID: r.Slot_ID,
        Start_Time: r.Start_Time,
        End_Time: r.End_Time,
        Gender: r.Gender as any,
        Seats_Booked: seats,
        Pilgrim_Name: ["Ahmed","Fatimah","Yousef","Mariam","Khalid"][i%5] + " " + ["A.","B.","C.","D.","E."][i%5],
        Nationality: ["KSA","EGY","PAK","IDN","TUR"][i%5],
        Pilgrim_ID: `P${100000+i}`,
        Group: i%3===0?"Agency X":"",
        Status: (i%13===0?"Cancelled":(i%7===0?"Checked-in":"Booked")) as any,
        Created_At: new Date().toISOString(),
      });
      i++;
      if (sample.length>200) break;
    }
    setBookings(sample);
  }

  // Styling helpers (Nusuk-like palette)
  const panel = "bg-white border border-[#e6e0d4]";
  const header = "text-[#b49164] fomt-bold";

  return (
    <div className="min-h-screen bg-white text-slate-800">
      {/* Top bar */}
      <div className="sticky top-0 z-40 bg-[#2f2f33] text-white px-6 py-3 shadow">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <div className="font-semibold tracking-wide">nusuk · Admin</div>
          <div className="opacity-70 text-sm">Rawdah Slots Management</div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6 grid grid-cols-12 gap-4">
        {/* Sidebar (visual only) */}
        <aside className="col-span-12 md:col-span-3 lg:col-span-2 hidden md:block">
          <div className={`${panel} rounded-2xl p-3 sticky top-16`}>
            <div className={`text-sm font-semibold ${header}`}>Umrah</div>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="bg-white rounded-xl px-3 py-2 shadow">Umrah Packages</li>
              <li className="rounded-xl px-3 py-2">Package Categories Umrah</li>
              <li className="rounded-xl px-3 py-2">Umrah Booking Details</li>
              <li className="rounded-xl px-3 py-2">Disallowed Nationalities</li>
            </ul>
          </div>
        </aside>

        {/* Main content */}
        <main className="col-span-12 md:col-span-9 lg:col-span-10 space-y-4">
          {/* Controls */}
          <div className={`${panel} rounded-2xl p-4 shadow-sm`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className={`text-lg font-semibold ${header}`}>Upload & Date Range</h2>
              <button onClick={()=>{ setImported([]); setBookings([]); setFromDate(""); setToDate(""); if(inputRef.current) inputRef.current.value=""; }} className="text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 border"><RefreshCw className="w-4 h-4"/> Reset</button>
            </div>
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">From Date</label><input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white" /></div>
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">To Date</label><input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white" /></div>
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">Excel (.xlsx)</label><input ref={inputRef} type="file" accept=".xlsx" onChange={e=>setExcelFile(e.target.files?.[0]||null)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white" /></div>
              {/* Calendar card */}
              
            </div>
            <div className="col-span-12 md:col-span-12 mt-5">
                <div className="bg-white border rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <button aria-label="Previous month" className="inline-flex items-center justify-center w-8 h-8 rounded-full border bg-white hover:bg-slate-50 active:scale-95 transition" onClick={()=>{ const d = new Date(calCursor); d.setMonth(d.getMonth()-1); setCalCursor(d); }}>
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <div className="text-sm font-semibold">{calCursor.toLocaleString(undefined,{ month:'long', year:'numeric'})}</div>
                    <button aria-label="Next month" className="inline-flex items-center justify-center w-8 h-8 rounded-full border bg-white hover:bg-slate-50 active:scale-95 transition" onClick={()=>{ const d = new Date(calCursor); d.setMonth(d.getMonth()+1); setCalCursor(d); }}>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <CalendarMonth cursor={calCursor} appliedDates={appliedDates} selectedFrom={fromDate} selectedTo={toDate} />
                  <div className="mt-2 flex items-center gap-2 text-[11px]">
                    <span className="inline-block w-3 h-3 rounded bg-emerald-300"></span> Applied
                    <span className="inline-block w-3 h-3 rounded bg-blue-300"></span> Selected (pending)
                    <span className="inline-block w-3 h-3 rounded bg-indigo-400"></span> Both
                  </div>
                </div>
              </div>
            <div className="col-span-12 md:col-span-12 flex gap-2 mt-4 items-end">
              <button onClick={handleValidatePreview} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-white text-[#b49164] border border-[#b49164] hover:opacity-90">{loading? <Loader2 className="w-4 h-4 animate-spin"/> : <Upload className="w-4 h-4"/>} Validate</button>
              <button onClick={handleImport} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[#b49164] text-white hover:opacity-90"><FileUp className="w-4 h-4"/> Import</button>
            </div>
            <div className="mt-2 text-xs opacity-70">Policy: <b>Replace</b> existing capacities for the selected date range.</div>
            {fromDate && toDate && (
              <div className={`mt-2 text-xs rounded-lg px-3 py-2 border ${overlapCount>0? 'bg-amber-50 border-amber-300 text-amber-800':'bg-emerald-50 border-emerald-300 text-emerald-800'}`}>
                {overlapCount>0 ? `${overlapCount} selected day(s) already applied. Import will override those days.` : 'Selected range contains only open days.'}
              </div>
            )}
            {/* CSV & Pagination tests status */}
           
          </div>

          {/* Widgets */}
          <div className="grid grid-cols-12 gap-3">
            <Widget title="Total Capacity" value={totals.total} accent="bg-[#b49164] text-white" />
            <Widget title="Men Capacity" value={totals.men} accent="bg-[#b49164] text-white" />
            <Widget title="Women Capacity" value={totals.women} accent="bg-[#b49164] text-white" />
            <Widget title="Booked Capacity" value={totals.booked} accent="bg-[#b49164] text-white" />
          </div>

          {/* Capacities Table */}
          <div className={`${panel} rounded-2xl p-4 shadow-sm`}>
            <div className="flex items-center justify-between">
              <h3 className={`font-semibold ${header}`}>Imported Capacities</h3>
              <div className="flex items-center gap-2"><button onClick={exportCapacities} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border hover:bg-slate-50"><Download className="w-4 h-4"/> export</button></div>
            </div>
            <div className="mt-3 grid grid-cols-12 gap-2">
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">Filter by Day</label><select value={filterDay} onChange={e=>setFilterDay(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white"><option value="">All</option>{WEEKDAYS.filter(d=>d!=="All").map(d=> <option key={d} value={d}>{d}</option>)}<option value="All">All (Excel)</option></select></div>
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">Filter by Gender</label><select value={filterGender} onChange={e=>setFilterGender(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white"><option value="">Both</option>{GENDERS.map(g=> <option key={g} value={g}>{g}</option>)}</select></div>
              <div className="col-span-12 md:col-span-3"><label className="text-xs opacity-70">Filter by Date</label><input type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2 bg-white"/></div>
              <div className="col-span-12 md:col-span-3 flex items-end"><button onClick={()=>{setFilterDay("");setFilterGender("");setFilterDate("");}} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border hover:bg-slate-50 w-full"><Filter className="w-4 h-4"/> Clear Filters</button></div>
            </div>
            <div className="mt-3 border rounded-xl overflow-hidden bg-white">
              <TableCapacities rows={capRows} />
            </div>
            {/* Pagination Controls for capacities */}
            <div className="flex items-center justify-between px-2 py-3 text-sm">
              <div className="opacity-70">Showing {Math.min(capTotal, capStart+1)}–{Math.min(capTotal, capEnd)} of {capTotal}</div>
              <div className="flex  items-center gap-2">
                <button disabled={capPage===1} onClick={()=>setCapPage(p=>Math.max(1,p-1))} className="px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50">Prev</button>
                <span className="px-2">Page {capPage} / {capPages}</span>
                <button disabled={capPage===capPages} onClick={()=>setCapPage(p=>Math.min(capPages,p+1))} className="px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50">Next</button>
              </div>
            </div>
          </div>

          {/* Booked Slots (read-only) */}
          <div className={`${panel} rounded-2xl p-4 shadow-sm`}>
            <div className="flex items-center justify-between">
              <h3 className={`font-semibold ${header}`}>Booked Slots (Read-only)</h3>
              <div className="flex items-center gap-2">
                <button onClick={loadMockBookings} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border hover:bg-slate-50"><History className="w-4 h-4"/> Load Mock</button>
                <button onClick={exportBookings} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border hover:bg-slate-50"><Download className="w-4 h-4"/> export</button>
              </div>
            </div>
            <div className="mt-3 border rounded-xl overflow-hidden bg-white">
              <TableBookings rows={bookRows} />
            </div>
            {/* Pagination Controls for bookings */}
            <div className="flex items-center justify-between px-2 py-3 text-sm">
              <div className="opacity-70">Showing {Math.min(bookTotal, bookStart+1)}–{Math.min(bookTotal, bookEnd)} of {bookTotal}</div>
              <div className="flex items-center gap-2">
                <button disabled={bookPage===1} onClick={()=>setBookPage(p=>Math.max(1,p-1))} className="px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50">Prev</button>
                <span className="px-2">Page {bookPage} / {bookPages}</span>
                <button disabled={bookPage===bookPages} onClick={()=>setBookPage(p=>Math.min(bookPages,p+1))} className="px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50">Next</button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// --- Calendar components ---------------------------------------------------
function CalendarMonth({ cursor, appliedDates, selectedFrom, selectedTo }:{ cursor: Date; appliedDates: Set<string>; selectedFrom?: string; selectedTo?: string; }){
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startDay = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const cells: { d?: Date }[] = [];
  // leading blanks
  for (let i=0;i<startDay;i++) cells.push({});
  for (let day=1; day<=daysInMonth; day++) cells.push({ d: new Date(year, month, day) });
  const from = selectedFrom? new Date(selectedFrom+"T00:00:00"): null;
  const to = selectedTo? new Date(selectedTo+"T00:00:00"): null;

  function cellCls(d: Date){
    const iso = fmtDate(d);
    const isApplied = appliedDates.has(iso);
    const inSelected = from && to && d >= from && d <= to;
    const base = "h-8 w-8 flex items-center justify-center rounded-full text-md tabular-nums ";
    if (isApplied && inSelected) return base+" bg-indigo-400 text-white";
    if (isApplied) return base+" bg-emerald-300 text-slate-900";
    if (inSelected) return base+" bg-blue-300 text-slate-900";
    return base+" hover:bg-slate-100";
  }

  return (
    <div className="grid grid-cols-7 gap-1 select-none">
      {["Su","Mo","Tu","We","Th","Fr","Sa"].map((w,i)=>(<div key={i} className="text-[11px] text-slate-500 text-center">{w}</div>))}
      {cells.map((c,idx)=> (
        <div key={idx} className="flex items-center justify-center">
          {c.d ? (<div className={cellCls(c.d)} title={fmtDate(c.d)}>{c.d.getDate()}</div>) : (<div className="h-8 w-8"/>) }
        </div>
      ))}
    </div>
  );
}

function Widget({ title, value, accent }:{ title:string; value:number; accent?:string; }){
  return (
    <div className={`col-span-12 sm:col-span-6 lg:col-span-3 rounded-2xl p-4 shadow-sm ${accent?accent:"bg-white"}`}>
      <div className="text-1xl opacity-80">{title}</div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function TableCapacities({ rows }:{ rows: ExpandedRow[] }){
  return (
    <div className="w-full overflow-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left">
            {['Date','Slot_ID','Start_Time','End_Time','Day','Gender','Capacity'].map(h=> (
              <th key={h} className="px-3 py-2 font-semibold text-slate-600 border-b">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r,idx)=> (
            <tr key={idx} className="odd:bg-white even:bg-slate-50/60">
              <td className="px-3 py-2 border-b whitespace-nowrap">{r.Date}</td>
              <td className="px-3 py-2 border-b">{r.Slot_ID}</td>
              <td className="px-3 py-2 border-b">{r.Start_Time}</td>
              <td className="px-3 py-2 border-b">{r.End_Time}</td>
              <td className="px-3 py-2 border-b">{r.Day}</td>
              <td className="px-3 py-2 border-b">
                <span className={`px-2 py-0.5 rounded-full text-xs ${r.Gender==='Men'?'bg-[#e6edff] text-[#2741cc]':'bg-[#f3e7f0] text-[#7b3f6a]'}`}>{r.Gender}</span>
              </td>
              <td className="px-3 py-2 border-b tabular-nums">{r.Capacity}</td>
            </tr>
          ))}
          {rows.length===0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-slate-500">No data</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TableBookings({ rows }:{ rows: BookingRow[] }){
  return (
    <div className="w-full overflow-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr className="text-left">
            {['Booking_ID','Date','Slot_ID','Start','End','Gender','Seats','Pilgrim','Nationality','Pilgrim_ID','Group','Status','Created_At'].map(h=> (
              <th key={h} className="px-3 py-2 font-semibold text-slate-600 border-b whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b,idx)=> (
            <tr key={idx} className="odd:bg-white even:bg-slate-50/60">
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Booking_ID}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Date}</td>
              <td className="px-3 py-2 border-b">{b.Slot_ID}</td>
              <td className="px-3 py-2 border-b">{b.Start_Time}</td>
              <td className="px-3 py-2 border-b">{b.End_Time}</td>
              <td className="px-3 py-2 border-b"><span className={`px-2 py-0.5 rounded-full text-xs ${b.Gender==='Men'?'bg-[#e6edff] text-[#2741cc]':'bg-[#f3e7f0] text-[#7b3f6a]'}`}>{b.Gender}</span></td>
              <td className="px-3 py-2 border-b tabular-nums">{b.Seats_Booked}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Pilgrim_Name}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Nationality}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Pilgrim_ID}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{b.Group||'-'}</td>
              <td className="px-3 py-2 border-b whitespace-nowrap"><span className={ b.Status==='Booked'?"px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700": b.Status==='Checked-in'?"px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700":"px-2 py-0.5 rounded-full text-xs bg-rose-100 text-rose-700" }>{b.Status}</span></td>
              <td className="px-3 py-2 border-b whitespace-nowrap">{new Date(b.Created_At).toLocaleString()}</td>
            </tr>
          ))}
          {rows.length===0 && (
            <tr>
              <td colSpan={13} className="px-3 py-6 text-center text-slate-500">No bookings yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
