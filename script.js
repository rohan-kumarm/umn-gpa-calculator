import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// pdf.js is loaded via <script> tag in index.html as window.pdfjsLib
const PDFJS_VERSION = "3.11.174";
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
}

/* ---------- Constants ---------- */
const GRADE_POINTS = {
  "A":  4.000,
  "A-": 3.667,
  "B+": 3.333,
  "B":  3.000,
  "B-": 2.667,
  "C+": 2.333,
  "C":  2.000,
  "C-": 1.667,
  "D+": 1.333,
  "D":  1.000,
  "F":  0.000,
};
const EMAIL_DOMAIN = "umngpa.local";

/* ---------- State ---------- */
const state = {
  user: null,        // { id, username }
  courses: [],
  prior: { gpa: "", credits: "" },
  whatIf: { currentGpa: "", currentCredits: "", targetGpa: "", futureCredits: "" },
};
let supabase = null;
let suppressSync = false; // don't save during initial load
let saveTimer = null;

const $ = (id) => document.getElementById(id);

/* ---------- Helpers ---------- */
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
function usernameToEmail(username) {
  return `${username.toLowerCase()}@${EMAIL_DOMAIN}`;
}
function fmtGpa(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(3);
}
function fmtNum(n, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/* ---------- Screen switching ---------- */
function showScreen(id) {
  ["setup-screen", "auth-screen", "app-screen"].forEach((s) => {
    $(s).hidden = s !== id;
  });
}

/* ---------- Setup check ---------- */
function isConfigured() {
  return (
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("YOUR_PROJECT") &&
    !SUPABASE_ANON_KEY.includes("YOUR_ANON")
  );
}

/* ---------- Auth ---------- */
async function handleSignup(e) {
  e.preventDefault();
  const form = e.target;
  const username = form.username.value.trim();
  const password = form.password.value;
  const errorEl = form.querySelector('[data-error="signup"]');
  const btn = form.querySelector('button[type="submit"]');

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Creating account…";

  try {
    const email = usernameToEmail(username);
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    if (!data.user) throw new Error("Account created but no session returned. Check that 'Confirm email' is disabled in Supabase Auth settings.");

    const { error: profileError } = await supabase
      .from("profiles")
      .insert({ id: data.user.id, username });
    if (profileError) {
      if (profileError.code === "23505") {
        throw new Error("That username is already taken.");
      }
      throw profileError;
    }

    await afterLogin(data.user.id, username);
  } catch (err) {
    errorEl.textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create account";
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const username = form.username.value.trim();
  const password = form.password.value;
  const errorEl = form.querySelector('[data-error="login"]');
  const btn = form.querySelector('button[type="submit"]');

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Logging in…";

  try {
    const email = usernameToEmail(username);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes("invalid")) {
        throw new Error("Incorrect username or password.");
      }
      throw error;
    }
    await afterLogin(data.user.id, username);
  } catch (err) {
    errorEl.textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Log in";
  }
}

async function handleLogout() {
  await supabase.auth.signOut();
  state.user = null;
  state.courses = [];
  state.prior = { gpa: "", credits: "" };
  state.whatIf = { currentGpa: "", currentCredits: "", targetGpa: "", futureCredits: "" };
  showScreen("auth-screen");
}

async function afterLogin(userId, knownUsername) {
  let username = knownUsername;
  if (!username) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .maybeSingle();
    username = profile?.username || "user";
  }
  state.user = { id: userId, username };
  await loadUserState();
  renderUserBox();
  renderAll();
  showScreen("app-screen");
}

/* ---------- Data sync ---------- */
async function loadUserState() {
  suppressSync = true;
  try {
    const { data, error } = await supabase
      .from("user_state")
      .select("courses, prior, what_if")
      .eq("user_id", state.user.id)
      .maybeSingle();
    if (error) throw error;

    if (data) {
      state.courses = Array.isArray(data.courses) ? data.courses : [];
      state.prior = data.prior && typeof data.prior === "object" ? data.prior : { gpa: "", credits: "" };
      state.whatIf = data.what_if && typeof data.what_if === "object" ? data.what_if : { currentGpa: "", currentCredits: "", targetGpa: "", futureCredits: "" };
    } else {
      state.courses = [];
      state.prior = { gpa: "", credits: "" };
      state.whatIf = { currentGpa: "", currentCredits: "", targetGpa: "", futureCredits: "" };
    }
  } finally {
    suppressSync = false;
  }
}

function setSyncStatus(kind, text) {
  const el = $("sync-indicator");
  el.className = `sync-indicator ${kind}`;
  el.textContent = text;
}

function scheduleSave() {
  if (suppressSync || !state.user) return;
  setSyncStatus("saving", "Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  if (!state.user) return;
  try {
    const { error } = await supabase.from("user_state").upsert({
      user_id: state.user.id,
      courses: state.courses,
      prior: state.prior,
      what_if: state.whatIf,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    setSyncStatus("saved", "Saved");
    setTimeout(() => {
      if ($("sync-indicator").classList.contains("saved")) {
        setSyncStatus("", "");
      }
    }, 1500);
  } catch (err) {
    setSyncStatus("error", "Save failed — will retry");
    setTimeout(saveNow, 3000);
  }
}

/* ---------- UI: user box ---------- */
function renderUserBox() {
  const u = state.user;
  if (!u) return;
  $("user-name").textContent = u.username;
  $("user-avatar").textContent = u.username.charAt(0);
}

/* ---------- UI: courses ---------- */
function buildGradeOptions(selected) {
  const grades = [...Object.keys(GRADE_POINTS), "S", "N", "P"];
  return grades
    .map((g) => `<option value="${g}" ${g === selected ? "selected" : ""}>${g}</option>`)
    .join("");
}

function renderCourses() {
  const body = $("course-body");
  if (state.courses.length === 0) {
    state.courses.push({ id: uid(), name: "", credits: "", grade: "" });
  }
  body.innerHTML = state.courses
    .map((c) => `
      <tr data-id="${c.id}">
        <td><input type="text" class="c-name" value="${escapeHtml(c.name)}" placeholder="Course name or code" /></td>
        <td><input type="number" class="c-credits" min="0" step="0.5" value="${escapeHtml(c.credits)}" placeholder="0" /></td>
        <td>
          <select class="c-grade">
            <option value="" ${c.grade === "" ? "selected" : ""}>—</option>
            ${buildGradeOptions(c.grade)}
          </select>
        </td>
        <td><button class="remove-btn" aria-label="Remove course" data-remove="${c.id}">&times;</button></td>
      </tr>`)
    .join("");
}

function addCourse() {
  state.courses.push({ id: uid(), name: "", credits: "", grade: "" });
  renderCourses();
  scheduleSave();
}

function removeCourse(id) {
  state.courses = state.courses.filter((c) => c.id !== id);
  if (state.courses.length === 0) state.courses.push({ id: uid(), name: "", credits: "", grade: "" });
  renderCourses();
  recalcAll();
  scheduleSave();
}

function clearCourses() {
  state.courses = [{ id: uid(), name: "", credits: "", grade: "" }];
  renderCourses();
  recalcAll();
  scheduleSave();
}

/* ---------- Calculations ---------- */
function computeSemester() {
  let qualityPoints = 0;
  let gradedCredits = 0;
  let totalCredits = 0;
  for (const c of state.courses) {
    const credits = parseFloat(c.credits);
    if (!Number.isFinite(credits) || credits <= 0) continue;
    totalCredits += credits;
    if (c.grade in GRADE_POINTS) {
      gradedCredits += credits;
      qualityPoints += credits * GRADE_POINTS[c.grade];
    }
  }
  const gpa = gradedCredits > 0 ? qualityPoints / gradedCredits : 0;
  return { gpa, qualityPoints, gradedCredits, totalCredits };
}

function recalcSemester() {
  const r = computeSemester();
  $("semester-gpa").textContent = r.gradedCredits > 0 ? fmtGpa(r.gpa) : "0.000";
  $("graded-credits").textContent = r.gradedCredits % 1 === 0 ? r.gradedCredits : r.gradedCredits.toFixed(1);
  $("total-credits").textContent = r.totalCredits % 1 === 0 ? r.totalCredits : r.totalCredits.toFixed(1);
  $("quality-points").textContent = fmtNum(r.qualityPoints, 2);
  return r;
}

function recalcCumulative(semesterResult) {
  const priorGpa = parseFloat(state.prior.gpa);
  const priorCredits = parseFloat(state.prior.credits);
  const sem = semesterResult || computeSemester();
  const priorValid = Number.isFinite(priorGpa) && Number.isFinite(priorCredits) && priorCredits >= 0 && priorGpa >= 0;

  if (!priorValid) {
    $("cumulative-gpa").textContent = sem.gradedCredits > 0 ? fmtGpa(sem.gpa) : "—";
    $("cumulative-credits").textContent = sem.gradedCredits || 0;
    return;
  }
  const totalPoints = priorGpa * priorCredits + sem.qualityPoints;
  const totalCredits = priorCredits + sem.gradedCredits;
  const cumGpa = totalCredits > 0 ? totalPoints / totalCredits : 0;
  $("cumulative-gpa").textContent = totalCredits > 0 ? fmtGpa(cumGpa) : "—";
  $("cumulative-credits").textContent = totalCredits % 1 === 0 ? totalCredits : totalCredits.toFixed(1);
}

function approximateLetter(gpa) {
  const entries = Object.entries(GRADE_POINTS);
  let best = entries[0];
  let bestDiff = Math.abs(entries[0][1] - gpa);
  for (const e of entries) {
    const d = Math.abs(e[1] - gpa);
    if (d < bestDiff) { best = e; bestDiff = d; }
  }
  return best[0];
}

function recalcWhatIf() {
  const cur = parseFloat(state.whatIf.currentGpa);
  const curC = parseFloat(state.whatIf.currentCredits);
  const tgt = parseFloat(state.whatIf.targetGpa);
  const fut = parseFloat(state.whatIf.futureCredits);
  const neededEl = $("wi-needed");
  const projectedEl = $("wi-projected");
  const msgEl = $("wi-message");

  if (![cur, curC, tgt, fut].every(Number.isFinite)) {
    neededEl.textContent = "—";
    projectedEl.textContent = "—";
    msgEl.textContent = "";
    return;
  }
  if (fut <= 0) {
    neededEl.textContent = "—";
    projectedEl.textContent = fmtGpa(cur);
    msgEl.textContent = "Enter future credits greater than 0.";
    return;
  }

  const needed = (tgt * (curC + fut) - cur * curC) / fut;
  const projectedIfMax = (cur * curC + 4 * fut) / (curC + fut);
  const projectedIfMin = (cur * curC + 0 * fut) / (curC + fut);

  if (needed > 4.0001) {
    neededEl.textContent = fmtGpa(needed);
    projectedEl.textContent = fmtGpa(projectedIfMax);
    msgEl.textContent = `Target is not reachable with ${fut} credits. Maximum achievable cumulative GPA is ${fmtGpa(projectedIfMax)}.`;
  } else if (needed < 0) {
    neededEl.textContent = "0.000";
    projectedEl.textContent = fmtGpa(tgt);
    msgEl.textContent = `You'll stay at or above the target even if you earn 0.0 on the next ${fut} credits (minimum projected: ${fmtGpa(projectedIfMin)}).`;
  } else {
    neededEl.textContent = fmtGpa(needed);
    projectedEl.textContent = fmtGpa(tgt);
    msgEl.textContent = `Average ~${approximateLetter(needed)} across the next ${fut} credits to reach ${fmtGpa(tgt)}.`;
  }
}

function recalcAll() {
  const sem = recalcSemester();
  recalcCumulative(sem);
  recalcWhatIf();
}

function renderAll() {
  renderCourses();
  $("prior-gpa").value = state.prior.gpa ?? "";
  $("prior-credits").value = state.prior.credits ?? "";
  $("wi-current-gpa").value = state.whatIf.currentGpa ?? "";
  $("wi-current-credits").value = state.whatIf.currentCredits ?? "";
  $("wi-target-gpa").value = state.whatIf.targetGpa ?? "";
  $("wi-future-credits").value = state.whatIf.futureCredits ?? "";
  recalcAll();
}

/* ---------- Wiring ---------- */
function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === target));
    });
  });
}

function wireAuthTabs() {
  document.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.authTab;
      document.querySelectorAll(".auth-tab").forEach((b) => b.classList.toggle("active", b === btn));
      $("login-form").classList.toggle("active", target === "login");
      $("signup-form").classList.toggle("active", target === "signup");
    });
  });
}

function wireCourseTable() {
  const body = $("course-body");
  body.addEventListener("input", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    const course = state.courses.find((c) => c.id === tr.dataset.id);
    if (!course) return;
    if (e.target.classList.contains("c-name")) course.name = e.target.value;
    if (e.target.classList.contains("c-credits")) course.credits = e.target.value;
    if (e.target.classList.contains("c-grade")) course.grade = e.target.value;
    recalcAll();
    scheduleSave();
  });
  body.addEventListener("change", (e) => {
    if (e.target.classList.contains("c-grade")) {
      recalcAll();
      scheduleSave();
    }
  });
  body.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) removeCourse(rm.dataset.remove);
  });

  $("add-course").addEventListener("click", addCourse);
  $("clear-courses").addEventListener("click", () => {
    if (confirm("Remove all courses?")) clearCourses();
  });
}

function wireCumulative() {
  const gpa = $("prior-gpa");
  const credits = $("prior-credits");
  const handler = () => {
    state.prior.gpa = gpa.value;
    state.prior.credits = credits.value;
    recalcAll();
    scheduleSave();
  };
  gpa.addEventListener("input", handler);
  credits.addEventListener("input", handler);
}

function wireWhatIf() {
  const map = {
    "wi-current-gpa": "currentGpa",
    "wi-current-credits": "currentCredits",
    "wi-target-gpa": "targetGpa",
    "wi-future-credits": "futureCredits",
  };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    el.addEventListener("input", () => {
      state.whatIf[key] = el.value;
      recalcWhatIf();
      scheduleSave();
    });
  }
}

function wireAuth() {
  $("login-form").addEventListener("submit", handleLogin);
  $("signup-form").addEventListener("submit", handleSignup);
  $("logout-btn").addEventListener("click", handleLogout);
}

/* ---------- Transcript import ---------- */
const TERM_RE = /^(Fall|Spring|Summer|Winter|May)\s+Semester\s+(\d{4})$/i;
const COURSE_RE = /^([A-Z]{2,5})\s+(\d{3,4}[A-Z]?)\s+(.+?)\s+([\d.]+)\s+([\d.]+)(?:\s+([A-F][+-]?|S|N|P|W|I))?\s+([\d.]+)$/;
const TERM_GPA_RE = /^TERM\s*GPA\s*:?\s*([\d.]+)\s+TERM\s*TOTALS\s*:?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/i;
const CUM_GPA_RE = /^CUM\s*GPA\s*:?\s*([\d.]+)\s+UM\s*TOTALS\s*:?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/i;
const VALID_GRADES = new Set([...Object.keys(GRADE_POINTS), "S", "N", "P"]);

let lastImport = null; // { terms, cumulative }

function extractLines(items) {
  const rows = new Map();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(item);
  }
  const ys = [...rows.keys()].sort((a, b) => b - a);
  return ys
    .map((y) =>
      rows.get(y)
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((l) => l.length > 0);
}

async function parseTranscriptPdf(file) {
  if (!window.pdfjsLib) {
    throw new Error("PDF library didn't load. Check your internet connection and reload.");
  }
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const allLines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    allLines.push(...extractLines(content.items));
  }
  return parseLines(allLines);
}

function parseLines(lines) {
  const terms = [];
  let currentTerm = null;
  let cumulative = null;

  for (const raw of lines) {
    const line = raw.trim();

    const tMatch = line.match(TERM_RE);
    if (tMatch) {
      if (currentTerm) terms.push(currentTerm);
      currentTerm = { name: `${capitalize(tMatch[1])} ${tMatch[2]}`, courses: [] };
      continue;
    }

    const tgMatch = line.match(TERM_GPA_RE);
    if (tgMatch && currentTerm) {
      currentTerm.gpa = parseFloat(tgMatch[1]);
      currentTerm.attempted = parseFloat(tgMatch[2]);
      currentTerm.earned = parseFloat(tgMatch[3]);
      currentTerm.gpaCredits = parseFloat(tgMatch[4]);
      currentTerm.points = parseFloat(tgMatch[5]);
      terms.push(currentTerm);
      currentTerm = null;
      continue;
    }

    const cMatch = line.match(CUM_GPA_RE);
    if (cMatch) {
      cumulative = {
        gpa: parseFloat(cMatch[1]),
        attempted: parseFloat(cMatch[2]),
        earned: parseFloat(cMatch[3]),
        gpaCredits: parseFloat(cMatch[4]),
        points: parseFloat(cMatch[5]),
      };
      continue;
    }

    const courseMatch = line.match(COURSE_RE);
    if (courseMatch && currentTerm) {
      const [, dept, num, desc, attempted, _earned, grade] = courseMatch;
      const normalizedGrade = grade && VALID_GRADES.has(grade) ? grade : "";
      currentTerm.courses.push({
        name: `${dept} ${num} ${desc.trim()}`,
        credits: attempted,
        grade: normalizedGrade,
      });
    }
  }

  if (currentTerm) terms.push(currentTerm);
  return { terms, cumulative };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function openImportModal() {
  $("import-modal").hidden = false;
}
function closeImportModal() {
  $("import-modal").hidden = true;
}

function setImportStatus(text) {
  $("import-status").textContent = text;
}

function renderImportTerms() {
  const parsed = lastImport;
  const container = $("import-terms");
  container.innerHTML = "";
  if (!parsed || !parsed.terms.length) {
    setImportStatus("No semesters found in this PDF. Make sure it's an unofficial transcript from MyU.");
    return;
  }
  const cum = parsed.cumulative;
  const cumText = cum ? `Transcript cumulative: ${cum.gpa.toFixed(3)} GPA · ${cum.gpaCredits} graded credits. ` : "";
  setImportStatus(`${cumText}Click a graded term to save it to Cumulative, or an in-progress term to load it into the Semester tab.`);

  parsed.terms.forEach((t, i) => {
    const isInProgress = t.courses.every((c) => !c.grade);
    const isApplied = parsed.applied.has(i);
    const btn = document.createElement("button");
    btn.className = "term-option";
    btn.dataset.termIndex = String(i);
    btn.dataset.action = isInProgress ? "load-semester" : "add-cumulative";
    btn.disabled = isApplied;
    const courseWord = t.courses.length === 1 ? "course" : "courses";
    let summary;
    if (isInProgress) {
      summary = `In progress · ${t.courses.length} ${courseWord} · Load into Semester tab`;
    } else if (isApplied) {
      summary = `✓ Added to Cumulative (${Number.isFinite(t.gpa) ? t.gpa.toFixed(3) : "—"} GPA, ${t.gpaCredits ?? ""} credits)`;
    } else {
      summary = `GPA ${Number.isFinite(t.gpa) ? t.gpa.toFixed(3) : "—"} · ${t.gpaCredits ?? ""} credits · ${t.courses.length} ${courseWord} · Save to Cumulative`;
    }
    btn.innerHTML = `<strong>${escapeHtml(t.name)}</strong><span>${escapeHtml(summary)}</span>`;
    container.appendChild(btn);
  });
}

function handleTermClick(termIndex) {
  if (!lastImport) return;
  const term = lastImport.terms[termIndex];
  if (!term) return;
  const isInProgress = term.courses.every((c) => !c.grade);

  if (isInProgress) {
    loadTermIntoSemester(termIndex);
    closeImportModal();
    setSyncStatus("saved", `Loaded ${term.name} into Semester tab`);
    setTimeout(() => {
      if ($("sync-indicator").classList.contains("saved")) setSyncStatus("", "");
    }, 2500);
  } else {
    if (lastImport.applied.has(termIndex)) return;
    const ok = accumulateTermIntoPrior(termIndex);
    if (ok) {
      renderImportTerms();
      setSyncStatus("saved", `Added ${term.name} to Cumulative`);
      setTimeout(() => {
        if ($("sync-indicator").classList.contains("saved")) setSyncStatus("", "");
      }, 2500);
    }
  }
}

async function handleTranscriptFile(file) {
  if (!file) return;
  openImportModal();
  setImportStatus("Parsing your transcript…");
  $("import-terms").innerHTML = "";
  try {
    const parsed = await parseTranscriptPdf(file);
    parsed.applied = new Set();
    lastImport = parsed;
    renderImportTerms();
  } catch (err) {
    setImportStatus(`Couldn't read the PDF: ${err.message || err}`);
  }
}

function accumulateTermIntoPrior(termIndex) {
  const term = lastImport.terms[termIndex];
  if (!term || !Number.isFinite(term.points) || !Number.isFinite(term.gpaCredits) || term.gpaCredits <= 0) {
    return false;
  }
  const existingCredits = parseFloat(state.prior.credits) || 0;
  const existingGpa = parseFloat(state.prior.gpa) || 0;
  const existingPoints = existingGpa * existingCredits;
  const newPoints = existingPoints + term.points;
  const newCredits = existingCredits + term.gpaCredits;
  const newGpa = newCredits > 0 ? newPoints / newCredits : 0;

  state.prior.gpa = newGpa.toFixed(3);
  state.prior.credits = String(newCredits);
  state.whatIf = {
    ...state.whatIf,
    currentGpa: newGpa.toFixed(3),
    currentCredits: String(newCredits),
  };
  lastImport.applied.add(termIndex);
  renderAll();
  scheduleSave();
  return true;
}

function loadTermIntoSemester(termIndex) {
  const term = lastImport.terms[termIndex];
  if (!term) return;
  state.courses = term.courses.map((c) => ({
    id: uid(),
    name: c.name,
    credits: c.credits,
    grade: c.grade,
  }));
  if (state.courses.length === 0) {
    state.courses.push({ id: uid(), name: "", credits: "", grade: "" });
  }
  renderAll();
  scheduleSave();
}

function wireImport() {
  const btn = $("import-transcript");
  const input = $("transcript-file");
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    handleTranscriptFile(file);
    input.value = "";
  });

  const modal = $("import-modal");
  modal.addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined) return closeImportModal();
    const termBtn = e.target.closest(".term-option");
    if (termBtn && !termBtn.disabled) handleTermClick(parseInt(termBtn.dataset.termIndex, 10));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeImportModal();
  });
}

/* ---------- Init ---------- */
async function init() {
  if (!isConfigured()) {
    showScreen("setup-screen");
    return;
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage },
  });

  wireTabs();
  wireAuthTabs();
  wireAuth();
  wireCourseTable();
  wireCumulative();
  wireWhatIf();
  wireImport();

  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    await afterLogin(session.user.id, null);
  } else {
    showScreen("auth-screen");
  }
}

document.addEventListener("DOMContentLoaded", init);
