const state = {
  meta: null,
  annotator: null,
  batch: null,
  work: [],
  index: 0,
};

const el = (id) => document.getElementById(id);

const STORE_PREFIX = "anno_web_v1:";
const LAST_KEY = "anno_web_v1_last";
const memoryStore = {};
const CSV_FIELDS = ["assignment_id","assignment_role","batch_id","task_id","annotator_id","independent_slot","qc_source_assignment_id","instruction_version","assignment_status","label","risk_privacy_spread","risk_attack_abuse","risk_rumor_spread","risk_extreme_incitement","risk_obvious_irrelevant","risk_other","other_target","note","started_at","saved_at","submitted_at"];

function loadState(annotator) {
  const key = STORE_PREFIX + annotator;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return memoryStore[key] || {}; }
}

function writeState(annotator, data) {
  const key = STORE_PREFIX + annotator;
  memoryStore[key] = data;
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch { throw new Error("浏览器本地存储不可用，无法保存（请换用 Chrome/Edge 打开）"); }
}

function assignmentResult(template, saved) {
  const risk = saved?.risk_flags || {};
  return {
    ...template,
    assignment_status: saved?.assignment_status || "pending",
    label: saved?.label || "",
    risk_privacy_spread: risk.privacy_spread ?? "",
    risk_attack_abuse: risk.attack_abuse ?? "",
    risk_rumor_spread: risk.rumor_spread ?? "",
    risk_extreme_incitement: risk.extreme_incitement ?? "",
    risk_obvious_irrelevant: risk.obvious_irrelevant ?? "",
    risk_other: risk.other ?? "",
    other_target: saved?.other_target || "",
    note: saved?.note || "",
    started_at: saved?.started_at || "",
    saved_at: saved?.saved_at || "",
    submitted_at: saved?.submitted_at || "",
  };
}

function validateSubmission(payload) {
  const labelIds = new Set(window.META.label_options.map((option) => option.id));
  if (!labelIds.has(payload.label)) throw new Error("请选择有效标签");
  if (payload.label === "risk" && !Object.values(payload.risk_flags || {}).some(Boolean)) {
    throw new Error("请勾选至少一项风险");
  }
  if (payload.label === "other_target" && !payload.other_target) {
    throw new Error("请选择更适合的引导目标");
  }
}

function loadBatchData(batch) {
  window.BATCHES = window.BATCHES || {};
  if (window.BATCHES[batch]) return Promise.resolve(window.BATCHES[batch]);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `data/batch_${batch}.js`;
    script.onload = () => resolve(window.BATCHES[batch]);
    script.onerror = () => reject(new Error(`批次数据 data/batch_${batch}.js 加载失败`));
    document.head.appendChild(script);
  });
}

// 与原服务端一致：按人员+批次过滤，主标在前、抽检在后，各自按批内位置排序
async function getWork(annotator, batch) {
  const data = await loadBatchData(batch);
  const templates = data.assignments
    .filter((item) => item.annotator_id === annotator)
    .sort((left, right) => {
      if (left.assignment_role !== right.assignment_role) {
        return left.assignment_role === "primary" ? -1 : 1;
      }
      return Number(data.tasks[left.task_id].batch_position) - Number(data.tasks[right.task_id].batch_position);
    });
  const saved = loadState(annotator);
  return templates.map((template) => ({
    assignment: assignmentResult(template, saved[template.assignment_id]),
    task: data.tasks[template.task_id],
  }));
}

function saveAnnotation(annotator, template, body) {
  const all = loadState(annotator);
  const existing = all[body.assignment_id];
  if (existing?.assignment_status === "submitted") throw new Error("该结果已提交并锁定");
  const action = body.action === "submit" ? "submit" : "save";
  if (action === "submit") validateSubmission(body);
  const now = new Date().toISOString();
  const saved = {
    label: body.label || "",
    risk_flags: body.risk_flags || {},
    other_target: body.other_target || "",
    note: body.note || "",
    started_at: existing?.started_at || now,
    saved_at: now,
    submitted_at: action === "submit" ? now : "",
    assignment_status: action === "submit" ? "submitted" : "draft",
    template,
  };
  all[body.assignment_id] = saved;
  writeState(annotator, all);
  return assignmentResult(template, saved);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  const all = loadState(state.annotator);
  const rows = Object.values(all)
    .filter((saved) => saved.assignment_status === "submitted" && saved.template)
    .map((saved) => assignmentResult(saved.template, saved))
    .sort((l, r) => (l.batch_id + l.assignment_role + l.submitted_at).localeCompare(r.batch_id + r.assignment_role + r.submitted_at));
  if (!rows.length) { el("form-error").textContent = "本人尚无已提交的结果可导出"; return; }
  const lines = [CSV_FIELDS.map(csvCell).join(",")];
  for (const row of rows) lines.push(CSV_FIELDS.map((f) => csvCell(row[f])).join(","));
  const blob = new Blob([`\ufeff${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.annotator}_标注结果_${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  el("form-error").textContent = `已导出 ${rows.length} 条已提交结果`;
}

function resetMine() {
  if (!confirm(`确定清空 ${state.annotator} 在本浏览器中的全部标注状态（草稿与已提交）吗？此操作不可恢复，建议先导出 CSV。`)) return;
  try { localStorage.removeItem(STORE_PREFIX + state.annotator); } catch {}
  delete memoryStore[STORE_PREFIX + state.annotator];
  loadWork(state.batch);
}

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function displayDate(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : value || "时间未知";
}

function showLogin() {
  el("login-view").hidden = false;
  el("app-view").hidden = true;
}

function showApp() {
  el("login-view").hidden = true;
  el("app-view").hidden = false;
  el("annotator-name").textContent = state.annotator;
}

function renderMeta() {
  el("annotator-select").innerHTML = state.meta.annotators
    .map((annotator) => `<option value="${annotator}">${annotator}</option>`)
    .join("");
  el("batch-select").innerHTML = state.meta.batches
    .map((batch) => `<option value="${batch}">${batch}</option>`)
    .join("");
  el("label-options").innerHTML = state.meta.label_options
    .map((option) => `
      <div class="label-option" data-label="${option.id}">
        <input type="radio" name="label" id="label-${option.id}" value="${option.id}" />
        <label for="label-${option.id}">${option.display}</label>
      </div>`)
    .join("");
  el("risk-options").innerHTML = state.meta.risk_options
    .map((option) => `<label><input type="checkbox" name="risk" value="${option.id}" />${option.display}</label>`)
    .join("");
}

async function loadWork(batch = state.meta.batches[0]) {
  el("save-state").textContent = "加载中…";
  state.work = await getWork(state.annotator, batch);
  state.batch = batch;
  const firstPending = state.work.findIndex(
    (item) => item.assignment.assignment_status !== "submitted",
  );
  state.index = firstPending >= 0 ? firstPending : 0;
  el("batch-select").value = batch;
  renderCurrent();
}

function current() { return state.work[state.index]; }

function renderTargets(task) {
  const targets = parseJson(task.all_guidance_targets, []);
  el("target-list").innerHTML = targets
    .map((target) => `<div class="target-item ${target === task.current_guidance_target ? "active" : ""}">${target}</div>`)
    .join("");
}

function renderHistory(task) {
  const history = parseJson(task.history_items, []);
  el("history-list").innerHTML = history
    .map((item) => `
      <article class="history-item">
        <div class="history-meta">${displayDate(item.created_at)} · ${item.emotion_label || "未知"} · 转${item.repost_count} / 评${item.comment_count} / 赞${item.like_count}</div>
        <p class="history-text fold-text">${escapeHtml(item.text || "")}</p>
        <button type="button" class="fold-btn">展开原文</button>
      </article>`)
    .join("");
  document.querySelectorAll("#history-list .history-item").forEach((box) => setupFold(box.querySelector(".history-text"), box.querySelector(".fold-btn")));
}

function setupFold(textEl, btn) {
  textEl.classList.add("fold-text");
  btn.textContent = "展开原文";
  btn.style.display = "none";
  if (textEl.scrollHeight > textEl.clientHeight + 1) {
    btn.style.display = "inline-block";
    btn.onclick = () => {
      const folded = textEl.classList.toggle("fold-text");
      btn.textContent = folded ? "展开原文" : "收起";
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function attribute(label, value) {
  return `<div class="attribute-item"><dt>${label}</dt><dd>${escapeHtml(value || "未提供")}</dd></div>`;
}

function fillForm(assignment, task) {
  const locked = assignment.assignment_status === "submitted";
  document.querySelectorAll('input[name="label"]').forEach((input) => {
    input.checked = input.value === assignment.label;
    input.disabled = locked;
  });
  const risks = {
    privacy_spread: assignment.risk_privacy_spread,
    attack_abuse: assignment.risk_attack_abuse,
    rumor_spread: assignment.risk_rumor_spread,
    extreme_incitement: assignment.risk_extreme_incitement,
    obvious_irrelevant: assignment.risk_obvious_irrelevant,
    other: assignment.risk_other,
  };
  document.querySelectorAll('input[name="risk"]').forEach((input) => {
    input.checked = String(risks[input.value]).toLowerCase() === "true";
    input.disabled = locked;
  });
  const targets = parseJson(task.all_guidance_targets, []).filter(
    (target) => target !== task.current_guidance_target,
  );
  el("other-target-select").innerHTML = `<option value="">请选择</option>${targets
    .map((target) => `<option value="${target}">${target}</option>`)
    .join("")}`;
  el("other-target-select").value = assignment.other_target || "";
  el("other-target-select").disabled = locked;
  el("note-input").value = assignment.note || "";
  el("note-input").disabled = locked;
  el("save-button").disabled = locked;
  el("submit-button").disabled = locked;
  el("lock-state").textContent = locked ? "已提交锁定" : assignment.assignment_status === "draft" ? "已暂存" : "待标注";
  toggleConditionalFields();
}

function toggleConditionalFields() {
  const selected = document.querySelector('input[name="label"]:checked')?.value;
  el("risk-fieldset").hidden = selected !== "risk";
  el("other-target-field").hidden = selected !== "other_target";
}

function renderCurrent() {
  if (!state.work.length) return;
  const { assignment, task } = current();
  const eventEmotion = parseJson(task.event_emotion_distribution, {});
  const eventInteraction = parseJson(task.event_interaction_summary, {});
  el("event-name").textContent = task.event_name;
  el("event-stats").innerHTML = [
    ...Object.entries(eventEmotion).slice(0, 5).map(([key, value]) => `<span class="stat-chip">${key} ${value}</span>`),
    `<span class="stat-chip">互动P50 ${eventInteraction.p50 ?? "-"}</span>`,
    `<span class="stat-chip">互动P90 ${eventInteraction.p90 ?? "-"}</span>`,
  ].join("");
  renderTargets(task);
  el("guidance-instruction").textContent = task.guidance_instruction;
  el("masked-user").textContent = task.masked_user_id;
  el("history-summary").textContent = task.history_summary + (Number(task.history_omitted_count) > 0 ? `；其余${task.history_omitted_count}条未展开` : "");
  renderHistory(task);
  el("candidate-event").textContent = task.candidate_event_name;
  el("assignment-role").textContent = assignment.assignment_role === "qc_repeat" ? "重复抽检" : "主标注";
  el("candidate-text").textContent = task.candidate_text;
  setupFold(el("candidate-text"), el("candidate-fold"));
  el("candidate-attributes").innerHTML = [
    attribute("发布时间", displayDate(task.candidate_created_at)),
    attribute("情绪", task.candidate_emotion),
    attribute("主体类型", task.publisher_type),
    attribute("粉丝量级", task.fan_tier),
    attribute("互动量等级", task.interaction_tier),
    attribute("转发 / 评论 / 点赞", `${task.repost_count} / ${task.comment_count} / ${task.like_count}`),
    attribute("国家", task.country),
    attribute("省份", task.province),
    attribute("城市", task.city),
  ].join("");
  el("candidate-source").textContent = task.candidate_source;
  el("candidate-group").textContent = task.candidate_group;
  el("boundary-flag").textContent = String(task.is_boundary_candidate).toLowerCase() === "true" ? "边界候选" : "";
  el("boundary-flag").className = String(task.is_boundary_candidate).toLowerCase() === "true" ? "boundary" : "";
  fillForm(assignment, task);
  updateProgress();
  el("task-position").textContent = `${state.index + 1} / ${state.work.length}`;
  el("previous-button").disabled = state.index === 0;
  el("next-button").disabled = state.index === state.work.length - 1;
  el("form-error").textContent = "";
}

function updateProgress() {
  const submitted = state.work.filter(
    (item) => item.assignment.assignment_status === "submitted",
  ).length;
  const percent = state.work.length ? (submitted / state.work.length) * 100 : 0;
  el("progress-text").textContent = `${submitted} / ${state.work.length}`;
  el("progress-bar").style.width = `${percent}%`;
  el("save-state").textContent = current()?.assignment.assignment_status === "submitted" ? "已提交" : current()?.assignment.assignment_status === "draft" ? "已暂存" : "未保存";
}

function formPayload(action) {
  const selected = document.querySelector('input[name="label"]:checked')?.value || "";
  const risks = {};
  document.querySelectorAll('input[name="risk"]').forEach((input) => {
    risks[input.value] = input.checked;
  });
  return {
    assignment_id: current().assignment.assignment_id,
    action,
    label: selected,
    risk_flags: risks,
    other_target: el("other-target-select").value,
    note: el("note-input").value.trim(),
  };
}

function save(action) {
  try {
    const body = formPayload(action);
    const saved = saveAnnotation(state.annotator, current().assignment, body);
    current().assignment = saved;
    renderCurrent();
    if (action === "submit") {
      const nextPending = state.work.findIndex(
        (item, index) => index > state.index && item.assignment.assignment_status !== "submitted",
      );
      if (nextPending >= 0) {
        state.index = nextPending;
        renderCurrent();
      }
    }
  } catch (error) {
    el("form-error").textContent = error.message;
  }
}

el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.annotator = el("annotator-select").value;
    try { localStorage.setItem(LAST_KEY, state.annotator); } catch {}
    showApp();
    await loadWork();
  } catch (error) {
    el("login-error").textContent = error.message;
  }
});
el("batch-select").addEventListener("change", (event) => loadWork(event.target.value).catch((e) => { el("form-error").textContent = e.message; }));
el("logout-button").addEventListener("click", () => {
  try { localStorage.removeItem(LAST_KEY); } catch {}
  state.annotator = null;
  showLogin();
});
el("export-button").addEventListener("click", exportCsv);
el("reset-button").addEventListener("click", resetMine);
el("label-options").addEventListener("change", toggleConditionalFields);
el("save-button").addEventListener("click", () => save("save"));
el("annotation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  save("submit");
});
el("previous-button").addEventListener("click", () => { state.index -= 1; renderCurrent(); });
el("next-button").addEventListener("click", () => { state.index += 1; renderCurrent(); });

state.meta = window.META;
renderMeta();
let last = null;
try { last = localStorage.getItem(LAST_KEY); } catch {}
if (last && state.meta.annotators.includes(last)) {
  state.annotator = last;
  el("annotator-select").value = last;
  showApp();
  loadWork().catch((e) => { el("form-error").textContent = e.message; });
} else {
  showLogin();
}
