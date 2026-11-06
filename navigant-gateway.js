/* =====================================================================
   navigant-gateway.js  (v4)  -  Navigant Core frontend gateway
   1) Intercepts the 4 website forms, validates (incl. WhatsApp/phone) and POSTs JSON to the API
   2) Loads the PUBLIC impact widget  (GET /api/public/impact-summary)
   3) Runs the secure ADMIN dashboard (X-Admin-Token) with Chart.js charts
   Plain vanilla JS - no build step.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- API base --------------------------------------------------
     - Served by the Express container (localhost:5000 or your own domain): same origin -> "".
     - Hosted somewhere else (e.g. Netlify): set <meta name="navigant-api-base" content="https://your-api-domain">
       in index.html. A visitor's browser can NOT reach "localhost" on your PC, so Netlify needs a public URL
       that points to your Docker server (e.g. a Cloudflare Tunnel - free, still self-hosted).        */
  function apiBase() {
    var meta = document.querySelector('meta[name="navigant-api-base"]');
    if (meta && meta.content.trim()) return meta.content.trim().replace(/\/+$/, "");
    if (window.NAVIGANT_API_BASE) return String(window.NAVIGANT_API_BASE).replace(/\/+$/, "");
    if (location.protocol === "file:") return "http://localhost:5000";   // index.html opened by double-click
    var h = location.hostname;
    if ((h === "localhost" || h === "127.0.0.1") && location.port && location.port !== "5000") return "http://localhost:5000";
    return "";
  }
  var API = apiBase();
  console.info("[Navigant] gateway v6, API base:", API || "(same origin)");

  var TOKEN_KEY = "navigant_admin_token";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Phone validation (mirrors phone.js on the server) ---------- */
  var DEFAULT_CC = "92";
  function normalizePhone(input) {
    var raw = String(input || "").trim();
    if (!raw || raw.length > 30 || /[^\d\s+\-().]/.test(raw)) return null;
    var d = raw.replace(/\D/g, ""), out;
    if (!d) return null;
    if (raw.charAt(0) === "+") out = "+" + d;
    else if (d.indexOf("00") === 0) out = "+" + d.slice(2);
    else if (d.charAt(0) === "0") out = "+" + DEFAULT_CC + d.slice(1);
    else if (DEFAULT_CC === "92" && d.length === 10 && d.charAt(0) === "3") out = "+92" + d;
    else if (d.indexOf(DEFAULT_CC) === 0 && d.length >= DEFAULT_CC.length + 8) out = "+" + d;
    else return null;
    if (!/^\+[1-9][0-9]{7,14}$/.test(out)) return null;
    if (out.indexOf("+92") === 0 && out.charAt(3) === "3" && out.length !== 13) return null;
    return out;
  }
  window.NavigantPhone = { normalize: normalizePhone };

  /* ---------- Network helper ---------- */
  function request(method, path, body, headers) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    var opts = { method: method, headers: Object.assign({ Accept: "application/json" }, headers || {}), signal: ctrl.signal };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(API + path, opts).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { ok: res.ok, status: res.status, data: data, nonJson: data === null };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, data: null, networkError: true, aborted: err && err.name === "AbortError" };
    });
  }
  function friendlyError(r) {
    if (r.networkError) return r.aborted ? "The server took too long to answer. Please try again."
      : "Cannot reach the Navigant server. Please check your connection and try again.";
    if (r.nonJson) return "The website could not reach the Navigant API (it answered with a web page, not data). Ask the admin to check the API address.";
    if (r.data && r.data.error) return r.data.error;
    if (r.status === 429) return "Too many requests. Please wait a moment.";
    return "Something went wrong (" + r.status + "). Please try again.";
  }

  /* ---------- Form interception ---------- */
  function statusBox(form) {
    var box = form.querySelector(".nv-form-status");
    if (!box) {
      box = document.createElement("div");
      box.className = "nv-form-status";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      var btn = form.querySelector('button[type="submit"]');
      form.insertBefore(box, btn && btn.parentNode === form ? btn : null);
    }
    return box;
  }
  function setStatus(form, kind, msg) {
    var box = statusBox(form);
    box.className = "nv-form-status " + (kind ? "nv-" + kind : "");
    box.textContent = msg || "";
  }
  function val(form, name) {
    var el = form.elements[name];
    return el ? String(el.value || "").trim() : "";
  }

  function wireForm(formName, endpoint, build, successMsg, closeFn) {
    var form = document.querySelector('form[name="' + formName + '"]');
    if (!form) return;
    form.removeAttribute("action");
    form.setAttribute("novalidate", "novalidate");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');

      // browser-side required checks
      if (!form.checkValidity()) { form.reportValidity(); return; }
      // phone check with a clear message
      var phone = normalizePhone(val(form, "whatsapp-phone"));
      if (!phone) {
        setStatus(form, "error", "Please enter a valid WhatsApp / phone number, e.g. +92 300 0000000 or 0300 0000000.");
        var pe = form.elements["whatsapp-phone"]; if (pe) pe.focus();
        return;
      }
      var payload = build(form, phone);
      payload.bot_field = val(form, "bot-field");   // honeypot

      var label = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Submitting..."; }
      setStatus(form, "info", "Submitting, please wait...");

      request("POST", endpoint, payload).then(function (r) {
        if (r.ok) {
          setStatus(form, "success", successMsg);
          form.reset();
          if (closeFn && typeof window[closeFn] === "function") setTimeout(function () { window[closeFn](); setStatus(form, "", ""); }, 2600);
          loadPublicImpact(true);
        } else if (r.status === 409) {
          setStatus(form, "error", (r.data && r.data.error) || "This submission was already received.");
        } else {
          setStatus(form, "error", friendlyError(r));
        }
      }).then(function () {
        if (btn) { btn.disabled = false; btn.textContent = label; }
      });
    });
    // live hint under the phone field
    var ph = form.elements["whatsapp-phone"];
    if (ph) ph.addEventListener("blur", function () {
      var n = normalizePhone(ph.value);
      if (n) ph.value = n;
      ph.setCustomValidity("");
    });
  }

  function initForms() {
    wireForm("navigant-student-registration", "/api/submissions", function (f, phone) {
      var course = val(f, "course-choice");
      return {
        full_name: val(f, "full-name"), email: val(f, "email"), whatsapp_number: phone,
        selected_course: course,
        raw_biography: "Student registration form. Course selected: " + course + ".",
        gender: val(f, "gender"), profession: val(f, "profession"), city: val(f, "city"),
        delivery_mode: val(f, "delivery-mode")
      };
    }, "Thank you! Your registration was received. Our team will contact you on WhatsApp with the next steps.", "closeStudent");

    wireForm("navigant-community", "/api/volunteers", function (f, phone) {
      return {
        full_name: val(f, "name"), email: val(f, "email"), whatsapp_number: phone,
        skills_offered: val(f, "interest"), availability: "", details: val(f, "message")
      };
    }, "Thank you! Your interest was received. We will be in touch soon.", "closeCommunity");

    wireForm("navigant-internship", "/api/trainers", function (f, phone) {
      return {
        full_name: val(f, "candidate-name"), email: val(f, "candidate-email"), whatsapp_number: phone,
        expertise_domains: val(f, "target-assignment"), statement_of_intent: val(f, "statement-of-intent")
      };
    }, "Thank you! Your application was received. We will review it and contact you.", "closeInternship");

    wireForm("navigant-contact", "/api/inquiries", function (f, phone) {
      return {
        name: val(f, "name"), email: val(f, "email"), whatsapp_number: phone,
        classification: val(f, "inquiry-classification"), message: val(f, "message")
      };
    }, "Thank you! Your inquiry was received. We will reply by email or WhatsApp.", null);
  }

  /* ---------- PUBLIC impact widget ---------- */
  var impactTimer = null;
  function countUp(el, to) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var from = parseInt(el.getAttribute("data-value") || "0", 10) || 0;
    el.setAttribute("data-value", String(to));
    if (reduce || from === to) { el.textContent = to.toLocaleString(); return; }
    var start = null, dur = 900;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function loadPublicImpact(force) {
    var wrap = $("nv-impact");
    if (!wrap) return;
    clearTimeout(impactTimer);
    request("GET", "/api/public/impact-summary").then(function (r) {
      var note = $("nv-impact-note");
      if (!r.ok || !r.data) {
        wrap.querySelectorAll("[data-impact]").forEach(function (el) { if (!el.getAttribute("data-value")) el.textContent = "-"; });
        if (note) note.textContent = "Live figures are temporarily unavailable.";
      } else {
        var d = r.data;
        var map = { students: d.total_students_served, hours: d.total_coaching_hours, volunteers: d.total_volunteers, trainers: d.total_trainers };
        wrap.querySelectorAll("[data-impact]").forEach(function (el) { countUp(el, Number(map[el.getAttribute("data-impact")]) || 0); });
        if (note) note.textContent = d.updated_at ? "Live figures - last updated " + new Date(d.updated_at).toLocaleString() : "Live figures";
      }
      impactTimer = setTimeout(function () { loadPublicImpact(); }, 120000);
    });
  }

  /* ---------- ADMIN dashboard ---------- */
  var charts = {};
  var PALETTE = ["#047857", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#db2777", "#475569", "#0d9488"];
  var currentTab = "students";

  var STREAM_COLS = {
    students:   [["id", "ID"], ["full_name", "Name"], ["email", "Email"], ["whatsapp_number", "WhatsApp"], ["extracted_track", "Course"], ["status", "Status"], ["profession", "Profile"], ["city", "City"], ["created_at", "Registered"]],
    volunteers: [["id", "ID"], ["full_name", "Name"], ["email", "Email"], ["whatsapp_number", "WhatsApp"], ["skills_offered", "Contribution"], ["details", "Details"], ["created_at", "Received"]],
    trainers:   [["id", "ID"], ["full_name", "Name"], ["email", "Email"], ["whatsapp_number", "WhatsApp"], ["expertise_domains", "Target role"], ["statement_of_intent", "Statement of intent"], ["created_at", "Received"]],
    inquiries:  [["id", "ID"], ["name", "Name"], ["email", "Email"], ["whatsapp_number", "WhatsApp"], ["classification", "Type"], ["message", "Message"], ["created_at", "Received"]]
  };

  var memToken = "";   // fallback when the browser blocks sessionStorage (e.g. some file:// setups)
  function token() { try { return sessionStorage.getItem(TOKEN_KEY) || memToken; } catch (e) { return memToken; } }
  function setToken(t) { memToken = t || ""; try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function adminFetch(path) { return request("GET", path, undefined, { "X-Admin-Token": token() }); }

  function loadChartJs() {
    if (window.Chart) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Chart.js could not be loaded from the CDN.")); };
      document.head.appendChild(s);
    });
  }

  window.toggleAdminDashboard = function (show) {
    var modal = $("admin-dashboard-modal");
    if (!modal) return;
    modal.style.display = show ? "block" : "none";
    modal.setAttribute("aria-hidden", show ? "false" : "true");
    document.body.style.overflow = show ? "hidden" : "";
    if (show) {
      if (location.hash !== "#admin") history.replaceState(null, "", "#admin");
      showLogin(!token());
      if (token()) refreshDashboard(); else setTimeout(function () { var i = $("nv-admin-token"); if (i) i.focus(); }, 80);
    } else if (location.hash === "#admin") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };
  function showLogin(show, msg) {
    $("nv-admin-login").style.display = show ? "block" : "none";
    $("nv-admin-body").style.display = show ? "none" : "block";
    var err = $("nv-admin-login-err"); err.textContent = msg || "";
  }
  window.nvAdminLogin = function () {
    var v = ($("nv-admin-token").value || "").trim();
    if (!v) { showLogin(true, "Please enter the admin token."); return; }
    setToken(v);
    $("nv-admin-token").value = "";
    refreshDashboard();
  };
  window.nvAdminLock = function () { setToken(""); destroyCharts(); showLogin(true, ""); };

  function destroyCharts() { Object.keys(charts).forEach(function (k) { try { charts[k].destroy(); } catch (e) {} delete charts[k]; }); }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
  function mkChart(id, cfg) {
    var cv = $(id); if (!cv) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new window.Chart(cv.getContext("2d"), cfg);
  }
  function emptyNote(id, isEmpty) { var el = $(id); if (el) el.style.display = isEmpty ? "flex" : "none"; }

  function renderDashboard(d) {
    setText("metric-total-students", (d.total_students_enrolled || 0).toLocaleString());
    setText("nv-m-served", (d.total_students_served || 0).toLocaleString());
    setText("metric-free-hours", (d.free_technical_coaching_hours || 0).toLocaleString() + " hrs");
    setText("nv-m-unique", (d.unique_participants || 0).toLocaleString());
    setText("nv-m-vol", (d.total_volunteers || 0).toLocaleString());
    setText("nv-m-trn", (d.total_trainers || 0).toLocaleString());
    setText("nv-m-inq", (d.total_inquiries || 0).toLocaleString());
    setText("metric-timestamp", new Date(d.metrics_refreshed_at).toLocaleString());

    var trend = d.registration_trends || [];
    mkChart("nv-chart-monthly", {
      type: "bar",
      data: { labels: trend.map(function (r) { return r.label; }), datasets: [{ label: "Registrations", data: trend.map(function (r) { return r.count; }), backgroundColor: "#047857", borderRadius: 6, maxBarThickness: 46 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
    emptyNote("nv-empty-monthly", !trend.some(function (r) { return r.count > 0; }));

    var co = d.workshop_cohort_density || [];
    mkChart("nv-chart-cohort", {
      type: "pie",
      data: { labels: co.map(function (r) { return r.cohort + " (" + r.pct + "%)"; }), datasets: [{ data: co.map(function (r) { return r.count; }), backgroundColor: PALETTE, borderWidth: 2, borderColor: "#fff" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
    });
    emptyNote("nv-empty-cohort", !co.length);

    var tp = d.track_popularity || [];
    mkChart("nv-chart-tracks", {
      type: "bar",
      data: { labels: tp.map(function (r) { return r.track; }), datasets: [{ label: "Registrations", data: tp.map(function (r) { return r.count; }), backgroundColor: "#2563eb", borderRadius: 5 }] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
    emptyNote("nv-empty-tracks", !tp.length);

    var demo = d.demographics || {};
    function donut(id, rows) {
      mkChart(id, {
        type: "doughnut",
        data: { labels: (rows || []).map(function (r) { return r.label; }), datasets: [{ data: (rows || []).map(function (r) { return r.count; }), backgroundColor: PALETTE, borderWidth: 2, borderColor: "#fff" }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "bottom" } } }
      });
    }
    donut("nv-chart-profession", demo.profession);
    donut("nv-chart-gender", demo.gender);
    mkChart("nv-chart-city", {
      type: "bar",
      data: { labels: (demo.city || []).map(function (r) { return r.label; }), datasets: [{ label: "Registrations", data: (demo.city || []).map(function (r) { return r.count; }), backgroundColor: "#d97706", borderRadius: 5 }] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  }

  function refreshDashboard() {
    setText("nv-admin-state", "Loading...");
    Promise.all([loadChartJs().then(function () { return null; }, function (e) { return e; }), adminFetch("/api/admin/metrics")]).then(function (res) {
      var chartErr = res[0], r = res[1];
      if (r.status === 401 || r.status === 429 || r.status === 503) {
        if (r.status === 401) setToken("");
        showLogin(true, r.status === 401 ? "That token was not accepted." : friendlyError(r));
        return;
      }
      if (!r.ok || !r.data) { showLogin(false); setText("nv-admin-state", friendlyError(r)); return; }
      showLogin(false);
      setText("nv-admin-state", "Connected");
      if (chartErr) { setText("nv-admin-state", chartErr.message + " Numbers still work, charts are disabled."); }
      else renderDashboard(r.data);
      // numbers always render even if charts failed
      setText("metric-total-students", (r.data.total_students_enrolled || 0).toLocaleString());
      setText("nv-m-served", (r.data.total_students_served || 0).toLocaleString());
      setText("metric-free-hours", (r.data.free_technical_coaching_hours || 0).toLocaleString() + " hrs");
      setText("nv-m-unique", (r.data.unique_participants || 0).toLocaleString());
      setText("nv-m-vol", (r.data.total_volunteers || 0).toLocaleString());
      setText("nv-m-trn", (r.data.total_trainers || 0).toLocaleString());
      setText("nv-m-inq", (r.data.total_inquiries || 0).toLocaleString());
      setText("metric-timestamp", new Date(r.data.metrics_refreshed_at).toLocaleString());
      window.switchDashboardTab(currentTab);
    });
  }
  window.nvAdminRefresh = refreshDashboard;

  window.switchDashboardTab = function (name) {
    if (!STREAM_COLS[name]) name = "students";
    currentTab = name;
    Object.keys(STREAM_COLS).forEach(function (k) {
      var b = $("tab-btn-" + k); if (b) b.classList.toggle("active", k === name);
    });
    var box = $("matrix-stream-viewer");
    box.innerHTML = '<div class="nv-muted">Loading records...</div>';
    adminFetch("/api/admin/records/" + name + "?limit=50").then(function (r) {
      if (!r.ok || !r.data) { box.innerHTML = '<div class="nv-muted">' + esc(friendlyError(r)) + "</div>"; return; }
      if (!r.data.rows.length) { box.innerHTML = '<div class="nv-muted">No records in this stream yet.</div>'; return; }
      var cols = STREAM_COLS[name];
      var html = '<table class="nv-table"><thead><tr>' + cols.map(function (c) { return "<th>" + esc(c[1]) + "</th>"; }).join("") + "</tr></thead><tbody>";
      r.data.rows.forEach(function (row) {
        html += "<tr>" + cols.map(function (c) {
          var v = row[c[0]];
          if (c[0] === "created_at" && v) v = new Date(v).toLocaleDateString();
          return '<td title="' + esc(v) + '">' + esc(v) + "</td>";
        }).join("") + "</tr>";
      });
      box.innerHTML = html + "</tbody></table>";
    });
  };

  function initAdmin() {
    var link = $("nv-staff-link");
    if (link) link.addEventListener("click", function (e) { e.preventDefault(); window.toggleAdminDashboard(true); });
    var inp = $("nv-admin-token");
    if (inp) inp.addEventListener("keydown", function (e) { if (e.key === "Enter") window.nvAdminLogin(); });
    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) { e.preventDefault(); window.toggleAdminDashboard(true); }
      if (e.key === "Escape" && $("admin-dashboard-modal") && $("admin-dashboard-modal").style.display === "block") window.toggleAdminDashboard(false);
    });
    window.addEventListener("hashchange", function () { if (location.hash === "#admin") window.toggleAdminDashboard(true); });
    if (location.hash === "#admin") window.toggleAdminDashboard(true);
  }

  function boot() { initForms(); loadPublicImpact(); initAdmin(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
