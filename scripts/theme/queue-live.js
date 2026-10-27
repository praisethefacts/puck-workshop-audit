// Live view of automated audit runs.
// Polls the deployed data/audit-runs.json while a run is active and
// re-renders the step timeline. Reloads once a run reaches a final state so
// the freshly published report page and ledger links appear.
(function () {
  var list = document.getElementById("automation-list");
  if (!list) return;

  var POLL_MS = 8000;
  var lastStates = {};
  var timer = null;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var RUN_STATE = {
    queued: { label: "Queued", cls: "open" },
    running: { label: "Running", cls: "open" },
    done: { label: "Report ready", cls: "closed" },
    blocked: { label: "Blocked", cls: "closed" },
    failed: { label: "Failed", cls: "closed" },
    skipped: { label: "Skipped", cls: "closed" }
  };
  var STEP_STATE = { pending: "waiting", running: "active", done: "done", failed: "failed", skipped: "skipped" };
  var ACTIVE = { queued: 1, running: 1 };

  function stamp(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return (
      d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
      " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC"
    );
  }

  function runMarkup(run) {
    var state = RUN_STATE[run.state] || RUN_STATE.queued;
    var steps = (run.steps || [])
      .map(function (step) {
        var cls = STEP_STATE[step.state] || "waiting";
        var detail = step.detail ? '<span class="run-step-detail">' + esc(step.detail) + "</span>" : "";
        return (
          '<li class="run-step run-step--' + cls + '">' +
          '<span class="run-dot" aria-hidden="true"></span>' +
          '<span class="run-step-label">' + esc(step.label || step.key) + "</span>" +
          detail +
          "</li>"
        );
      })
      .join("");
    var title = run.title || "Workshop item " + run.id;
    var report = run.report
      ? '<a class="text-link run-report-link" href="reports/' + esc(run.id) + '.html">Automated triage report<span aria-hidden="true"> \u2192</span></a>'
      : "";
    var note = run.note ? '<p class="run-note">' + esc(run.note) + "</p>" : "";
    return (
      '<li class="run-row" data-run-id="' + esc(run.id) + '" data-run-state="' + esc(run.state) + '">' +
      '<div class="run-head"><div>' +
      '<p class="request-title"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=' + esc(run.id) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '<span class="external-mark" aria-hidden="true">\u2197</span></a></p>' +
      '<p class="request-meta">Mod ' + esc(run.id) + (run.issue ? " \u00b7 Issue #" + esc(run.issue) : "") + " \u00b7 started " + stamp(run.startedAt) + "</p>" +
      "</div>" +
      '<span class="request-status request-status--' + state.cls + '">' + esc(state.label) + "</span>" +
      "</div>" +
      '<ol class="run-steps" aria-label="Audit steps">' + steps + "</ol>" +
      note +
      report +
      "</li>"
    );
  }

  function apply(runs) {
    var active = runs.filter(function (run) { return ACTIVE[run.state]; });
    var recent = runs
      .filter(function (run) { return !ACTIVE[run.state]; })
      .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); })
      .slice(0, 6);
    var ordered = active.concat(recent);
    if (ordered.length) list.innerHTML = ordered.map(runMarkup).join("\n");

    var badge = document.querySelector("[data-run-live]");
    if (badge) {
      badge.setAttribute("data-run-live", active.length ? "on" : "off");
      badge.className = "run-live" + (active.length ? " run-live--on" : "");
      badge.innerHTML = '<span class="run-live-dot" aria-hidden="true"></span>' + (active.length ? "Live" : "Idle");
    }

    // If a run moved to a final state, reload so new report pages exist.
    var reload = false;
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      var prev = lastStates[run.id];
      if (prev && ACTIVE[prev] && !ACTIVE[run.state]) reload = true;
      lastStates[run.id] = run.state;
    }
    if (reload) {
      setTimeout(function () { window.location.reload(); }, 1200);
      return false;
    }
    return active.length > 0;
  }

  function poll() {
    fetch("data/audit-runs.json?ts=" + Date.now(), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        var runs = (payload && payload.runs) || [];
        var keepPolling = apply(runs);
        if (!keepPolling && timer) {
          clearInterval(timer);
          timer = null;
        }
      })
      .catch(function () {
        // The site is static: a failed poll just means no fresh state yet.
      });
  }

  lastStates = {};
  poll();
  timer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) poll();
  });
})();
