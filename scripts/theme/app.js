/* Puck Workshop audit — progressive enhancement for the ledger and requests. */
(function () {
  "use strict";

  document.documentElement.classList.add("js");

  var GITHUB_ISSUES = "https://github.com/praisethefacts/puck-workshop-audit/issues";
  var loadQueue = null;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function normalize(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function formatDate(value) {
    var date = new Date(value);
    if (!value || isNaN(date.getTime())) return String(value || "");
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function safeHttpUrl(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!/^(?:https?:)?\/\//i.test(raw)) return "";
    try {
      var url = new URL(raw, window.location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Ledger                                                                  */
  /* ---------------------------------------------------------------------- */

  var table = $("#mod-ledger");
  if (table) {
    var tbody = $("#ledger-body");
    var rows = $all("tbody tr", table);
    var search = $("#filter-q");
    var verdict = $("#filter-verdict");
    var kind = $("#filter-kind");
    var form = $("#ledger-filters");
    var count = $("#ledger-count");
    var sortNote = $("#ledger-sort-note");
    var empty = $("#ledger-empty");
    var sortButtons = $all("[data-sort]", table);
    var headers = $all("th[data-sort-key]", table);
    var state = { query: "", verdict: "all", kind: "all", sort: "score", dir: "desc" };

    rows.forEach(function (row) {
      row._audit = {
        row: row,
        name: row.getAttribute("data-name") || "",
        search: row.getAttribute("data-search") || "",
        score: Number(row.getAttribute("data-score")) || 0,
        verdict: row.getAttribute("data-verdict") || "",
        kind: row.getAttribute("data-kind") || "",
      };
    });

    function rowMatches(item) {
      if (state.verdict !== "all" && item.verdict !== state.verdict) return false;
      if (state.kind !== "all" && item.kind !== state.kind) return false;
      if (state.query && item.search.indexOf(state.query) === -1) return false;
      return true;
    }

    function updateSortHeader() {
      headers.forEach(function (header) {
        var key = header.getAttribute("data-sort-key");
        var active = key === state.sort;
        header.setAttribute("aria-sort", active ? (state.dir === "asc" ? "ascending" : "descending") : "none");
        var arrow = $(".sort-arrow", header);
        if (arrow) arrow.textContent = active ? (state.dir === "asc" ? "↑" : "↓") : "";
      });

      var label =
        state.sort === "name"
          ? "Sorted by name, " + (state.dir === "asc" ? "A to Z" : "Z to A")
          : "Sorted by risk score, " + (state.dir === "desc" ? "high to low" : "low to high");
      sortNote.textContent = label + " · filters update live";
    }

    function applySort() {
      var sorted = rows.slice().sort(function (a, b) {
        var left;
        var right;
        if (state.sort === "name") {
          left = a._audit.name;
          right = b._audit.name;
          var byName = left.localeCompare(right, undefined, { sensitivity: "base" });
          return state.dir === "asc" ? byName : -byName;
        }
        left = a._audit.score;
        right = b._audit.score;
        if (left === right) {
          return a._audit.name.localeCompare(b._audit.name, undefined, { sensitivity: "base" });
        }
        return state.dir === "asc" ? left - right : right - left;
      });

      var fragment = document.createDocumentFragment();
      sorted.forEach(function (item) {
        fragment.appendChild(item);
      });
      tbody.appendChild(fragment);
      updateSortHeader();
    }

    function applyFilters() {
      var shown = 0;
      rows.forEach(function (item) {
        var visible = rowMatches(item._audit);
        item.hidden = !visible;
        if (visible) shown += 1;
      });

      count.textContent =
        shown === rows.length
          ? "Showing " + rows.length + " of " + rows.length + " records"
          : "Showing " + shown + " of " + rows.length + " records";
      empty.hidden = shown !== 0;
      table.closest(".table-scroll").hidden = shown === 0;
      if (shown === 0) empty.hidden = false;
    }

    function applyAll() {
      applyFilters();
      applySort();
    }

    if (search) {
      search.addEventListener("input", function () {
        state.query = normalize(search.value);
        applyFilters();
      });
    }

    if (verdict) {
      verdict.addEventListener("change", function () {
        state.verdict = verdict.value;
        applyFilters();
      });
    }

    if (kind) {
      kind.addEventListener("change", function () {
        state.kind = kind.value;
        applyFilters();
      });
    }

    sortButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.getAttribute("data-sort");
        if (state.sort === key) {
          state.dir = state.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort = key;
          state.dir = key === "name" ? "asc" : "desc";
        }
        applySort();
      });
    });

    function resetLedger() {
      state = { query: "", verdict: "all", kind: "all", sort: "score", dir: "desc" };
      if (search) search.value = "";
      if (verdict) verdict.value = "all";
      if (kind) kind.value = "all";
      table.closest(".table-scroll").hidden = false;
      applyAll();
      if (search) search.focus();
    }

    if (form) {
      form.addEventListener("reset", function (event) {
        event.preventDefault();
        resetLedger();
      });
    }

    var emptyReset = $("#empty-reset");
    if (emptyReset) emptyReset.addEventListener("click", resetLedger);

    applySort();
  }

  /* ---------------------------------------------------------------------- */
  /* Request form                                                            */
  /* ---------------------------------------------------------------------- */

  var requestForm = $("#request-form");
  if (requestForm) {
    var modInput = $("#req-mod");
    var reasonInput = $("#req-reason");
    var contactInput = $("#req-contact");
    var submitButton = $("#request-submit");
    var formStatus = $("#request-status");
    var reasonCount = $("#reason-count");
    var contactCount = $("#contact-count");
    var submitting = false;

    function extractSteamId(value) {
      var text = String(value || "").trim();
      if (/^\d{5,20}$/.test(text)) return text;

      var protocol = /^steam:\/\/url\/CommunityFilePage\/(\d{5,20})\/?$/i.exec(text);
      if (protocol) return protocol[1];

      var link =
        /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/sharedfiles\/filedetails\/?\?[^\s#]*?\bid=(\d{5,20})(?:[&#\s]|$)/i.exec(
          text
        );
      return link ? link[1] : "";
    }

    function setFieldError(input, errorNode, message, fieldName) {
      if (message) {
        input.setAttribute("aria-invalid", "true");
        errorNode.textContent = message;
        errorNode.hidden = false;
        if (input.hasAttribute("required")) {
          input.setAttribute("aria-required", "true");
        }
        if (fieldName) errorNode.setAttribute("data-field", fieldName);
      } else {
        input.removeAttribute("aria-invalid");
        errorNode.textContent = "";
        errorNode.hidden = true;
        errorNode.removeAttribute("data-field");
      }
    }

    function clearStatus() {
      formStatus.hidden = true;
      formStatus.className = "form-status";
      formStatus.textContent = "";
    }

    function showStatus(kind, message, linkHref, linkLabel) {
      formStatus.hidden = false;
      formStatus.className = "form-status form-status--" + kind;
      formStatus.textContent = "";
      var text = document.createElement("span");
      text.textContent = message + " ";
      formStatus.appendChild(text);
      if (linkHref) {
        var link = document.createElement("a");
        link.href = linkHref;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = linkLabel || "Open GitHub issues";
        formStatus.appendChild(link);
      }
    }

    function updateCounters() {
      if (reasonCount) reasonCount.textContent = reasonInput.value.length + " / 2000";
      if (contactCount) contactCount.textContent = contactInput.value.length + " / 200";
    }

    function validateForm() {
      var firstInvalid = null;
      var mod = modInput.value.trim();
      var reason = reasonInput.value.trim();
      var contact = contactInput.value.trim();

      setFieldError(modInput, $("#mod-error"), "", "mod");
      setFieldError(reasonInput, $("#reason-error"), "", "reason");
      setFieldError(contactInput, $("#contact-error"), "", "contact");

      if (!mod) {
        setFieldError(modInput, $("#mod-error"), "Paste a Workshop link or the numeric file ID.", "mod");
        firstInvalid = firstInvalid || modInput;
      } else if (mod.length > 300) {
        setFieldError(modInput, $("#mod-error"), "Keep the Workshop reference under 300 characters.", "mod");
        firstInvalid = firstInvalid || modInput;
      } else if (!extractSteamId(mod)) {
        setFieldError(
          modInput,
          $("#mod-error"),
          "That does not contain a Steam Workshop ID. Use a link containing ?id=, a steam:// link, or the digits only.",
          "mod"
        );
        firstInvalid = firstInvalid || modInput;
      }

      if (reason.length > 2000) {
        setFieldError(reasonInput, $("#reason-error"), "Keep the reason under 2,000 characters.", "reason");
        firstInvalid = firstInvalid || reasonInput;
      }

      if (contact.length > 200) {
        setFieldError(contactInput, $("#contact-error"), "Keep contact details under 200 characters.", "contact");
        firstInvalid = firstInvalid || contactInput;
      }

      if (firstInvalid) {
        firstInvalid.focus();
        return null;
      }

      return {
        mod: mod,
        reason: reason,
        contact: contact,
      };
    }

    function setSubmitting(value) {
      submitting = value;
      submitButton.disabled = value;
      submitButton.setAttribute("aria-busy", value ? "true" : "false");
    }

    function apiMessage(payload) {
      if (payload && typeof payload.error === "string" && payload.error.trim()) {
        return payload.error.trim();
      }
      if (payload && typeof payload.message === "string" && payload.message.trim()) {
        return payload.message.trim();
      }
      return "";
    }

    modInput.addEventListener("input", function () {
      setFieldError(modInput, $("#mod-error"), "", "mod");
      clearStatus();
    });
    reasonInput.addEventListener("input", function () {
      updateCounters();
      setFieldError(reasonInput, $("#reason-error"), "", "reason");
      clearStatus();
    });
    contactInput.addEventListener("input", function () {
      updateCounters();
      setFieldError(contactInput, $("#contact-error"), "", "contact");
      clearStatus();
    });

    requestForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (submitting) return;

      var payload = validateForm();
      if (!payload) return;

      clearStatus();
      setSubmitting(true);

      var controller = new AbortController();
      var timer = window.setTimeout(function () {
        controller.abort();
      }, 20000);

      fetch("/api/request", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              return { response: response, body: body };
            });
        })
        .then(function (result) {
          var response = result.response;
          var body = result.body;
          var contentType = response.headers.get("content-type") || "";

          // Static copies (GitHub Pages) have no serverless function. The request is still
          // actionable: hand it to GitHub with everything pre-filled, where the audit
          // workflow picks it up. This is a normal step, not an error.
          if (!response.ok && contentType.indexOf("application/json") === -1) {
            var modId = extractSteamId(payload.mod) || payload.mod;
            var issueUrl =
              GITHUB_ISSUES.replace(/\/issues\/?$/, "") +
              "/issues/new?labels=mod-request&title=" +
              encodeURIComponent("Audit request: " + modId) +
              "&body=" +
              encodeURIComponent(
                "https://steamcommunity.com/sharedfiles/filedetails/?id=" +
                  modId +
                  "\n\n" +
                  (payload.reason ? "Why: " + payload.reason + "\n\n" : "") +
                  (payload.contact ? "Contact: " + payload.contact + "\n\n" : "") +
                  "Requested from https://praisethefacts.github.io/puck-workshop-audit/"
              );
            window.open(issueUrl, "_blank", "noopener");
            showStatus(
              "success",
              "Request ready — GitHub opened in a new tab. Press “Create” there and the automated audit starts by itself; the run shows up on this page.",
              issueUrl,
              "Open the pre-filled request again"
            );
            requestForm.reset();
            updateCounters();
            return;
          }

          if (response.ok && body && body.ok) {
            var issueUrl = safeHttpUrl(body.issueUrl || body.url || "");
            showStatus(
              "success",
              "Request created. It is now in the public queue.",
              issueUrl || GITHUB_ISSUES,
              issueUrl ? "Open the GitHub issue" : "Open GitHub issues"
            );
            requestForm.reset();
            updateCounters();
            if (typeof loadQueue === "function") loadQueue();
            return;
          }


          var message = apiMessage(body);
          if (response.status === 404) {
            message =
              "Steam could not find that item. It may be deleted or unlisted, so it cannot be queued.";
          } else if (response.status === 429) {
            var retry = response.headers.get("retry-after");
            message =
              "Rate limit reached. " +
              (retry ? "Try again in about " + retry + " seconds." : "Try again later.");
          } else if (response.status === 400 || response.status === 422) {
            message = message || "The request was rejected. Check the Workshop reference and lengths.";
          } else if (response.status >= 500) {
            message =
              message ||
              "The request API is unavailable right now. Nothing was queued.";
          }

          showStatus(
            "error",
            message || "The request could not be created. Nothing was queued.",
            response.status >= 500 || response.status === 429 ? GITHUB_ISSUES : "",
            "Open GitHub issues"
          );
        })
        .catch(function (error) {
          var timedOut = error && error.name === "AbortError";
          showStatus(
            "error",
            timedOut
              ? "The request timed out. Nothing was queued. Check your connection and try again, or open an issue directly on GitHub."
              : "The request API is unreachable. Nothing was queued. You can open an issue directly on GitHub.",
            GITHUB_ISSUES,
            "Open GitHub issues"
          );
        })
        .finally(function () {
          window.clearTimeout(timer);
          setSubmitting(false);
        });
    });

    updateCounters();
  }

  /* ---------------------------------------------------------------------- */
  /* Request queue                                                           */
  /* ---------------------------------------------------------------------- */

  var queuePanel = $("#queue-panel");
  if (queuePanel) {
    var queueList = $("#request-list");
    var queueLoading = $("#queue-loading");
    var queueError = $("#queue-error");
    var queueEmpty = $("#queue-empty");
    var queueUpdated = $("#queue-updated");
    var refreshButton = $("#queue-refresh");
    var queueState = "loading";
    var queueInFlight = false;

    function showQueueState(next) {
      queueState = next;
      queueLoading.hidden = next !== "loading";
      queueError.hidden = next !== "error";
      queueEmpty.hidden = next !== "empty";
      queueList.hidden = next !== "list";
      queuePanel.setAttribute("aria-busy", next === "loading" ? "true" : "false");
      if (refreshButton) {
        refreshButton.disabled = next === "loading";
        refreshButton.setAttribute("aria-busy", next === "loading" ? "true" : "false");
      }
    }

    function buildQueueItem(item) {
      var li = document.createElement("li");
      li.className = "request-row";

      var copy = document.createElement("div");
      var title = document.createElement("p");
      title.className = "request-title";
      var link = document.createElement("a");
      link.href = safeHttpUrl(item.url) || GITHUB_ISSUES;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = String(item.title || "Untitled request");
      title.appendChild(link);
      copy.appendChild(title);

      var meta = document.createElement("p");
      meta.className = "request-meta";
      var idMatch = String(item.title || "").match(/\((\d{5,20})\)\s*$/);
      var modId = String(item.modId || (idMatch ? idMatch[1] : "")).trim();
      if (!/^\d{5,20}$/.test(modId)) modId = "";
      var number = item.number ? "#" + item.number : "";
      var parts = [];
      if (modId) parts.push("Mod " + modId);
      if (number) parts.push("Issue " + number);
      if (item.createdAt) {
        var time = document.createElement("time");
        time.dateTime = String(item.createdAt);
        time.textContent = formatDate(item.createdAt);
        meta.appendChild(document.createTextNode((modId ? "Mod " + modId + " · " : "") + (number ? "Issue " + number + " · " : "")));
        meta.appendChild(time);
      } else {
        meta.textContent = parts.join(" · ");
      }
      copy.appendChild(meta);
      li.appendChild(copy);

      var status = document.createElement("span");
      var stateValue = normalize(item.state) === "closed" ? "closed" : "open";
      status.className = "request-status request-status--" + stateValue;
      status.textContent = stateValue === "open" ? "Open" : "Closed";
      li.appendChild(status);

      return li;
    }

    loadQueue = function loadQueueRequest() {
      if (queueInFlight) return;
      queueInFlight = true;
      showQueueState("loading");
      queueError.hidden = true;

      var controller = new AbortController();
      var timer = window.setTimeout(function () {
        controller.abort();
      }, 12000);

      fetch("/api/requests", {
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              if (!response.ok || !body || body.ok !== true || !Array.isArray(body.items)) {
                throw new Error("Queue response was not usable.");
              }
              return body.items;
            });
        })
        .then(function (items) {
          window.clearTimeout(timer);
          queueList.textContent = "";
          if (!items.length) {
            showQueueState("empty");
            queueUpdated.textContent = "Last checked just now · no requests";
            return;
          }

          var fragment = document.createDocumentFragment();
          items.forEach(function (item) {
            fragment.appendChild(buildQueueItem(item));
          });
          queueList.appendChild(fragment);
          showQueueState("list");
          queueUpdated.textContent =
            "Last checked just now · " + items.length + (items.length === 1 ? " request" : " requests");
        })
        .catch(function () {
          window.clearTimeout(timer);
          // Static mirrors (GitHub Pages) have no request API: fall back to the
          // queue snapshot committed with the site, so the list stays readable.
          fetch("data/requests.json?ts=" + Date.now(), { cache: "no-store", signal: controller.signal })
            .then(function (response) {
              if (!response.ok) throw new Error("no snapshot");
              return response.json();
            })
            .then(function (snapshot) {
              var items = snapshot && Array.isArray(snapshot.requests) ? snapshot.requests : null;
              if (!items) throw new Error("no snapshot");
              items = items.map(function (entry) {
                return {
                  number: entry.issue,
                  modId: entry.id,
                  title: entry.title || "Workshop item " + entry.id,
                  state: normalize(entry.status) === "closed" ? "closed" : "open",
                  createdAt: entry.requestedAt || "",
                  url:
                    entry.issue && GITHUB_ISSUES
                      ? GITHUB_ISSUES.replace(/\/issues\/?$/, "") + "/issues/" + entry.issue
                      : "",
                };
              });
              queueList.textContent = "";
              if (!items.length) {
                showQueueState("empty");
                queueUpdated.textContent = "Static queue snapshot · no requests";
                return;
              }
              var fragment = document.createDocumentFragment();
              items.forEach(function (item) {
                fragment.appendChild(buildQueueItem(item));
              });
              queueList.appendChild(fragment);
              showQueueState("list");
              queueUpdated.textContent =
                "Static snapshot from the repository · " +
                items.length +
                (items.length === 1 ? " request" : " requests") +
                " · open issues for live state";
            })
            .catch(function () {
              showQueueState("error");
              var detail = $("#queue-error-detail");
              if (detail) {
                detail.textContent =
                  "The API is unreachable or GitHub did not answer. The request queue lives on GitHub as issues labelled mod-request.";
              }
              queueUpdated.textContent = "Queue unavailable · GitHub issues still available";
            });
        })
        .finally(function () {
          window.clearTimeout(timer);
          queueInFlight = false;
        });
    };

    if (refreshButton) refreshButton.addEventListener("click", loadQueue);
    $all("[data-retry-queue]").forEach(function (button) {
      button.addEventListener("click", loadQueue);
    });

    loadQueue();
  }

  /* ------------------------------------------------------------------------
     Motion: sticky header, scroll reveals, score bars that fill on approach.
     Everything here is optional polish; without JS the page is fully static.
     ---------------------------------------------------------------------- */

  var reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function initStickyHeader() {
    var header = $(".site-header");
    if (!header) return;
    var ticking = false;

    function update() {
      ticking = false;
      header.classList.toggle("is-stuck", window.scrollY > 6);
    }

    window.addEventListener(
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  function initReveal() {
    var targets = $all(
      ".section > .shell > *, .stat, .finding-row, .verdict-panel, .record-score-panel, .request-form-panel, .queue-panel, .aside-block, .closing"
    );

    if (reducedMotion || !("IntersectionObserver" in window)) return;

    targets.forEach(function (element, index) {
      element.classList.add("reveal");
      element.style.transitionDelay = Math.min(index % 4, 3) * 60 + "ms";
    });

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
    );

    targets.forEach(function (element) {
      observer.observe(element);
    });
  }

  function initScoreBars() {
    var fills = $all(".score-fill");
    if (!fills.length) return;

    if (reducedMotion || !("IntersectionObserver" in window)) {
      fills.forEach(function (fill) {
        fill.classList.add("is-filling");
      });
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var fill = entry.target;
          var delay = Number(fill.getAttribute("data-delay") || 0);
          window.setTimeout(function () {
            fill.classList.add("is-filling");
          }, delay);
          observer.unobserve(fill);
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.2 }
    );

    fills.forEach(function (fill, index) {
      if (!fill.getAttribute("data-delay") && index < 24) {
        fill.setAttribute("data-delay", String(index * 26));
      }
      observer.observe(fill);
    });
  }

  function initMotion() {
    document.documentElement.classList.add("js");
    initStickyHeader();
    initReveal();
    initScoreBars();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMotion);
  } else {
    initMotion();
  }
})();
