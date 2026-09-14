import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PAYMENT_STATUSES = ["PendingPayment", "NotVerified", "Accepted", "Rejected"];
const PAGE_SIZE = 25;
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{14}$/;
let submissionsRequestInFlight = null;

function loadSubmissionsOnce(authAxios, params) {
  const key = JSON.stringify(params);
  if (submissionsRequestInFlight?.client === authAxios && submissionsRequestInFlight.key === key) {
    return submissionsRequestInFlight.promise;
  }

  const promise = authAxios.get("/receipt-review/submissions", { params });
  submissionsRequestInFlight = { client: authAxios, key, promise };
  promise.finally(() => {
    if (submissionsRequestInFlight?.promise === promise) submissionsRequestInFlight = null;
  }).catch(() => {});
  return promise;
}

function getErrorMessage(error, fallback = "Something went wrong") {
  return error?.response?.data?.error || error?.message || fallback;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amount)
    : String(value ?? "—");
}

function statusClasses(status) {
  if (status === "Accepted") return "bg-green-100 text-green-800";
  if (status === "Rejected") return "bg-red-100 text-red-800";
  if (status === "NotVerified") return "bg-amber-100 text-amber-800";
  return "bg-gray-100 text-gray-700";
}

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses(status)}`}>
      {status || "Unknown"}
    </span>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-gray-900">{value ?? "—"}</dd>
    </div>
  );
}

function getCandidateSubmission(candidate) {
  return candidate?.submission || candidate?.payment || candidate || {};
}

function getCandidateTicketId(candidate) {
  const submission = getCandidateSubmission(candidate);
  return candidate?.ticket_id || submission.ticket_id || candidate?.ticketId || "";
}

function getCandidateReceiptUrl(candidate) {
  const submission = getCandidateSubmission(candidate);
  return candidate?.s3_url || candidate?.receipt_pdf_url || submission.s3_url || submission.receipt_pdf_url || "";
}

function appendVerificationLog(logs, log) {
  if (!log) return logs || [];
  if ((logs || []).some((existingLog) => log.log_id && existingLog.log_id === log.log_id)) return logs;
  return [log, ...(logs || [])];
}

function mergePaymentUpdate(record, payment, logs = []) {
  const nextRecord = { ...record, ...(payment || {}) };
  const nestedKey = record?.submission ? "submission" : record?.payment ? "payment" : null;
  if (nestedKey) {
    nextRecord[nestedKey] = {
      ...record[nestedKey],
      ...(payment || {}),
      verification_logs: logs.reduce((candidate, log) => appendVerificationLog(candidate, log), record[nestedKey].verification_logs || []),
    };
  }
  nextRecord.verification_logs = logs.reduce((candidate, log) => appendVerificationLog(candidate, log), record?.verification_logs || []);
  return nextRecord;
}

function Pagination({ pagination, page, loading, onPageChange, noun = "items" }) {
  const totalPages = pagination?.total_pages || 0;
  return (
    <div className="flex items-center justify-between border-t p-4 text-sm">
      <span className="text-gray-500">Page {pagination?.page || page} of {totalPages || 0} · {pagination?.total || 0} {noun}</span>
      <div className="flex gap-2">
        <button type="button" disabled={page <= 1 || loading} onClick={() => onPageChange(Math.max(1, page - 1))} className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
        <button type="button" disabled={!totalPages || page >= totalPages || loading} onClick={() => onPageChange(page + 1)} className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

function ReviewSummary({ submission }) {
  const events = submission?.events || [];
  const members = submission?.hackathon?.members || [];
  return (
    <>
      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Participant" value={submission?.participant_name} />
        <Field label="Email" value={submission?.participant_email} />
        <Field label="Phone" value={submission?.participant_phone} />
        <Field label="Institution" value={submission?.participant_college_name} />
        <Field label="Ticket type" value={submission?.ticket_type} />
        <Field label="Amount paid" value={formatAmount(submission?.amount_paid)} />
        <Field label="Gender" value={submission?.participant_gender} />
        <Field label="Year of study" value={submission?.participant_year_of_study} />
      </dl>
      <div className="mt-6">
        <h3 className="font-semibold text-gray-900">Registered events</h3>
        {events.length === 0 ? <p className="mt-2 text-sm text-gray-500">No events associated with this ticket.</p> : <ul className="mt-2 space-y-2">{events.map((event, index) => <li key={event.event_id || `${event.name}-${index}`} className="rounded border bg-gray-50 p-3 text-sm"><div className="font-medium text-gray-900">{event.name || event.event_name || "Unnamed event"}</div><div className="mt-1 text-xs text-gray-500">{event.event_type || "—"} · {event.dept_name || "—"} · {formatDate(event.date)}</div></li>)}</ul>}
      </div>
      {submission?.hackathon && <div className="mt-6"><h3 className="font-semibold text-gray-900">Hackathon team</h3><dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Team" value={submission.hackathon.team_name} /><Field label="Domain" value={submission.hackathon.domain} /><Field label="Track" value={submission.hackathon.track} /><Field label="Problem statement" value={submission.hackathon.ps_description} /></dl><div className="mt-3 space-y-2">{members.map((member, index) => <div key={member.member_id || `${member.email}-${index}`} className="rounded border p-3 text-sm"><div className="font-medium text-gray-900">{member.name} {member.is_lead ? "(lead)" : ""}</div><div className="text-xs text-gray-500">{member.email} · {member.phno || "No phone"} · Year {member.year_of_study ?? "—"}</div></div>)}</div></div>}
    </>
  );
}

function ReceiptPreview({ submission, showHeading = true }) {
  const receiptUrl = submission?.s3_url || submission?.receipt_pdf_url;
  return (
    <div className="mt-6">
      {showHeading && <h3 className="font-semibold text-gray-900">Receipt PDF</h3>}
      {receiptUrl ? <div className="mt-2"><iframe title={`Receipt for ${submission.ticket_id || "payment"}`} src={receiptUrl} className="h-[360px] w-full rounded border bg-gray-100" /><a href={receiptUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline">Open PDF in a new tab</a></div> : <p className="mt-2 rounded bg-amber-50 p-3 text-sm text-amber-800">No receipt URL has been recorded yet.</p>}
    </div>
  );
}

function DecisionHistory({ logs }) {
  if (!logs?.length) return null;
  return <div className="mt-6 border-t pt-4"><h3 className="font-semibold text-gray-900">Decision history</h3><ul className="mt-2 space-y-2 text-sm">{logs.map((log, index) => <li key={log.log_id || `${log.action_taken}-${index}`} className="rounded bg-gray-50 p-3"><span className="font-medium">{log.action_taken}</span> by {log.volunteer_name || log.volunteer_email || "volunteer"} · {formatDate(log.verif_time)}</li>)}</ul></div>;
}

function CandidateCard({ candidate, selected, locked, disabled, onSelect }) {
  const submission = getCandidateSubmission(candidate);
  const ticketId = getCandidateTicketId(candidate);
  const missingReceipt = !getCandidateReceiptUrl(candidate);
  const status = submission.status || candidate.status;
  const selectable = status === "NotVerified" && !disabled && !locked && !missingReceipt;
  return <article className={`rounded-lg border p-4 ${selected ? "border-blue-500 ring-2 ring-blue-100" : "border-gray-200"}`}><div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Ticket ID</p><p className="break-all font-mono text-sm text-gray-900">{ticketId || "—"}</p><p className="mt-2 text-sm text-gray-500">Created {formatDate(submission.created_at)}</p></div><StatusBadge status={status} /></div><ReviewSummary submission={submission} /><ReceiptPreview submission={submission} /><div className="mt-6 border-t pt-4"><button type="button" disabled={!selectable} onClick={() => onSelect(ticketId)} className={`w-full rounded px-4 py-2 text-sm font-semibold ${selected ? "bg-blue-600 text-white" : "border border-blue-600 text-blue-700 hover:bg-blue-50"} disabled:cursor-not-allowed disabled:opacity-60`}>{locked ? "Locked winner (Accepted)" : status !== "NotVerified" ? `Read-only candidate (${status || "unknown state"})` : selected ? "Selected winner" : "Select as winner"}</button>{missingReceipt && <p className="mt-2 text-xs text-amber-700">Receipt URL missing; this candidate blocks conflict resolution.</p>}{!locked && status !== "NotVerified" && !missingReceipt && <p className="mt-2 text-xs text-gray-500">Read-only candidate; only NotVerified candidates can be selected as a new winner.</p>}</div><DecisionHistory logs={submission.verification_logs || candidate.verification_logs} /></article>;
}

function ReceiptReviewPage() {
  const { authAxios } = useAuth();
  const [registration, setRegistration] = useState(null);
  const [registrationLoading, setRegistrationLoading] = useState(true);
  const [tab, setTab] = useState("payments");
  const [statusFilter, setStatusFilter] = useState("all");
  const [ticketTypeFilter, setTicketTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [paymentIdLoading, setPaymentIdLoading] = useState(false);
  const [manualPaymentId, setManualPaymentId] = useState("");
  const [manualEntryError, setManualEntryError] = useState(null);
  const [conflictFilter, setConflictFilter] = useState("unresolved");
  const [conflictSearch, setConflictSearch] = useState("");
  const [debouncedConflictSearch, setDebouncedConflictSearch] = useState("");
  const [conflictPage, setConflictPage] = useState(1);
  const [conflictGroups, setConflictGroups] = useState([]);
  const [conflictPagination, setConflictPagination] = useState({ page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
  const [unresolvedTotal, setUnresolvedTotal] = useState(null);
  const [conflictListLoading, setConflictListLoading] = useState(false);
  const [conflictRefreshVersion, setConflictRefreshVersion] = useState(0);
  const [selectedConflictPaymentId, setSelectedConflictPaymentId] = useState(null);
  const [conflictDetail, setConflictDetail] = useState(null);
  const [conflictDetailLoading, setConflictDetailLoading] = useState(false);
  const [conflictWinnerId, setConflictWinnerId] = useState(null);
  const [conflictActionLoading, setConflictActionLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const registrationKnownRef = useRef(false);
  const registrationDeniedRef = useRef(false);
  const conflictListKeyRef = useRef(null);
  const conflictRefreshSeenRef = useRef(0);

  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { const timer = setTimeout(() => setDebouncedConflictSearch(conflictSearch.trim()), 350); return () => clearTimeout(timer); }, [conflictSearch]);

  useEffect(() => {
    if (registrationDeniedRef.current) return undefined;
    let active = true;
    const initialLoad = !registrationKnownRef.current;
    async function loadSubmissions() {
      setListLoading(true);
      if (initialLoad) setRegistrationLoading(true);
      setError(null);
      try {
        const response = await loadSubmissionsOnce(authAxios, { status: statusFilter === "all" ? undefined : statusFilter, ticket_type: ticketTypeFilter === "all" ? undefined : ticketTypeFilter, search: debouncedSearch || undefined, page, page_size: PAGE_SIZE });
        const data = response.data || {};
        if (active) {
          registrationKnownRef.current = true;
          registrationDeniedRef.current = data.registered === false;
          setRegistration({ registered: data.registered !== false, volunteer: data.volunteer || null });
          setItems(data.items || []);
          setPagination(data.pagination || { page, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
        }
      } catch (requestError) {
        if (active) {
          registrationKnownRef.current = true;
          if (requestError?.response?.status === 403) {
            registrationDeniedRef.current = true;
            setRegistration({ registered: false, volunteer: null });
            setItems([]);
            setPagination({ page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
          } else {
            setRegistration((current) => current || { registered: true, volunteer: null });
            setError(getErrorMessage(requestError, "Could not load receipt submissions"));
          }
        }
      } finally {
        if (active) {
          setListLoading(false);
          if (initialLoad) setRegistrationLoading(false);
        }
      }
    }
    loadSubmissions();
    return () => { active = false; };
  }, [authAxios, debouncedSearch, page, statusFilter, ticketTypeFilter]);

  const loadConflictGroups = useCallback(async () => {
    setConflictListLoading(true); setError(null);
    try { const response = await authAxios.get("/receipt-review/conflicts", { params: { state: conflictFilter, search: debouncedConflictSearch || undefined, page: conflictPage, page_size: PAGE_SIZE } }); const data = response.data || {}; setConflictGroups(data.items || data.conflicts || []); setConflictPagination(data.pagination || { page: conflictPage, page_size: PAGE_SIZE, total: 0, total_pages: 0 }); if (typeof data.unresolved_total === "number") setUnresolvedTotal(data.unresolved_total); else if (typeof data.pagination?.unresolved_total === "number") setUnresolvedTotal(data.pagination.unresolved_total); } catch (requestError) { setError(getErrorMessage(requestError, "Could not load payment conflicts")); } finally { setConflictListLoading(false); }
  }, [authAxios, conflictFilter, conflictPage, debouncedConflictSearch]);

  useEffect(() => {
    if (!registration?.registered || tab !== "conflicts") return undefined;
    let active = true;
    const queryKey = `${conflictFilter}|${debouncedConflictSearch}|${conflictPage}`;
    const refreshRequested = conflictRefreshSeenRef.current !== conflictRefreshVersion;
    if (conflictListKeyRef.current !== queryKey || refreshRequested) {
      conflictListKeyRef.current = queryKey;
      conflictRefreshSeenRef.current = conflictRefreshVersion;
      loadConflictGroups();
    }
    const timer = setInterval(() => { if (active) loadConflictGroups(); }, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [conflictFilter, conflictPage, conflictRefreshVersion, debouncedConflictSearch, loadConflictGroups, registration, registration?.registered, tab]);

  useEffect(() => { setManualPaymentId(""); setManualEntryError(null); }, [selectedId]);

  useEffect(() => {
    if (!registration?.registered || !selectedConflictPaymentId || conflictDetail?.payment_id === selectedConflictPaymentId) return undefined;
    let active = true;
    async function loadConflictDetail() { setConflictDetailLoading(true); setError(null); try { const response = await authAxios.get(`/receipt-review/conflicts/${encodeURIComponent(selectedConflictPaymentId)}`); const data = response.data || {}; const mergedConflict = { ...(data.conflict || {}), ...data, payment_id: data.payment_id || data.conflict?.payment_id || selectedConflictPaymentId, candidates: data.candidates || data.conflict?.candidates || [] }; if (active) { setConflictDetail(mergedConflict); if (mergedConflict.blocked && mergedConflict.blocked_reason) setError(`Conflict resolution blocked: ${String(mergedConflict.blocked_reason).replaceAll("_", " ")}`); } } catch (requestError) { if (active) { if (requestError?.response?.status === 403) setRegistration({ registered: false, volunteer: null }); setError(getErrorMessage(requestError, "Could not load conflict details")); } } finally { if (active) setConflictDetailLoading(false); } }
    loadConflictDetail();
    return () => { active = false; };
  }, [authAxios, conflictDetail, registration, selectedConflictPaymentId]);

  const detail = useMemo(() => items.find((item) => item.ticket_id === selectedId) || null, [items, selectedId]);

  const conflictCandidates = useMemo(() => conflictDetail?.candidates || [], [conflictDetail]);
  const acceptedCandidate = useMemo(() => conflictCandidates.find((candidate) => (getCandidateSubmission(candidate).status || candidate.status) === "Accepted"), [conflictCandidates]);
  const acceptedTicketId = conflictDetail?.accepted_ticket_id || getCandidateTicketId(acceptedCandidate);
  const hasMissingReceipt = conflictCandidates.some((candidate) => !getCandidateReceiptUrl(candidate));
  const conflictResolved = conflictDetail?.state === "resolved" || conflictDetail?.status === "resolved";
  const conflictResolutionAllowed = conflictDetail?.resolution_allowed !== false && conflictDetail?.blocked !== true && !conflictResolved && !hasMissingReceipt;
  useEffect(() => { setConflictWinnerId(acceptedTicketId || null); }, [acceptedTicketId, selectedConflictPaymentId]);

  function selectConflictGroup(paymentId) {
    setSelectedConflictPaymentId(paymentId);
    setConflictDetail((current) => current?.payment_id === paymentId ? current : null);
  }

  function openConflictGroup(paymentId) { if (!paymentId) return; setTab("conflicts"); setConflictFilter("unresolved"); selectConflictGroup(paymentId); setMessage("This payment belongs to a conflict group. Resolve the group before deciding an individual payment."); }

  async function decide(status) {
    if (!selectedId || detail?.status !== "NotVerified" || detail?.conflict_review_required) return;
    setActionLoading(true); setError(null); setMessage(null);
    try {
      const response = await authAxios.patch(`/receipt-review/submissions/${selectedId}/decision`, { status });
      const responseData = response.data || {};
      const payment = responseData.payment || { ticket_id: selectedId, status };
      const log = responseData.log;
      setItems((currentItems) => currentItems.map((item) => item.ticket_id === (payment.ticket_id || selectedId) ? mergePaymentUpdate(item, payment, log ? [log] : []) : item));
      setMessage(`Payment marked ${status}.`);
    } catch (requestError) {
      const responseData = requestError?.response?.data || {};
      if (responseData.code === "CONFLICT_REVIEW_REQUIRED") openConflictGroup(responseData.payment_id || detail.payment_id);
      else { const currentStatus = responseData.current_status; setError(currentStatus ? `${getErrorMessage(requestError)} Current status: ${currentStatus}.` : getErrorMessage(requestError, "Could not save the receipt decision")); }
    } finally { setActionLoading(false); }
  }

  async function savePaymentId() {
    if (!selectedId || detail?.payment_id !== "queued") return;
    setPaymentIdLoading(true); setManualEntryError(null); setMessage(null);
    try {
      const response = await authAxios.patch(`/receipt-review/submissions/${selectedId}/payment-id`, { payment_id: manualPaymentId });
      const payment = response.data?.payment || { ticket_id: selectedId, payment_id: manualPaymentId };
      setItems((currentItems) => currentItems.map((item) => item.ticket_id === (payment.ticket_id || selectedId) ? mergePaymentUpdate(item, payment) : item));
      setManualPaymentId("");
      setMessage("Payment ID saved.");
    } catch (requestError) { setManualEntryError(getErrorMessage(requestError, "Could not save the payment ID")); } finally { setPaymentIdLoading(false); }
  }

  async function resolveConflict() {
    if (!selectedConflictPaymentId || !conflictWinnerId || !conflictResolutionAllowed) return;
    const winner = conflictCandidates.find((candidate) => getCandidateTicketId(candidate) === conflictWinnerId); const loserCount = conflictCandidates.filter((candidate) => (getCandidateSubmission(candidate).status || candidate.status) === "NotVerified" && getCandidateTicketId(candidate) !== conflictWinnerId).length; const winnerName = getCandidateSubmission(winner)?.participant_name || winner?.participant_name || winner?.ticket_id || conflictWinnerId;
    if (!window.confirm(`Select ${winnerName} as the winner and reject ${loserCount} loser${loserCount === 1 ? "" : "s"}?`)) return;
    setConflictActionLoading(true); setError(null); setMessage(null);
    try {
      const response = await authAxios.patch(`/receipt-review/conflicts/${encodeURIComponent(selectedConflictPaymentId)}/decision`, { winner_ticket_id: conflictWinnerId });
      const responseData = response.data || {};
      const payments = responseData.payments || [];
      const logs = responseData.logs || [];
      const paymentByTicket = new Map(payments.map((payment) => [payment.ticket_id, payment]));
      const logsByTicket = new Map();
      logs.forEach((log) => logsByTicket.set(log.ticket_id, [...(logsByTicket.get(log.ticket_id) || []), log]));
      setItems((currentItems) => currentItems.map((item) => paymentByTicket.has(item.ticket_id) ? mergePaymentUpdate(item, paymentByTicket.get(item.ticket_id), logsByTicket.get(item.ticket_id) || []) : item));
      setConflictDetail((current) => current ? { ...current, state: "resolved", status: "resolved", candidates: (current.candidates || []).map((candidate) => { const ticketId = getCandidateTicketId(candidate); return paymentByTicket.has(ticketId) ? mergePaymentUpdate(candidate, paymentByTicket.get(ticketId), logsByTicket.get(ticketId) || []) : candidate; }) } : current);
      setConflictGroups((groups) => conflictFilter === "unresolved" ? groups.filter((group) => (group.payment_id || group.paymentId || group.id || group.conflict_id) !== selectedConflictPaymentId) : groups.map((group) => (group.payment_id || group.paymentId || group.id || group.conflict_id) === selectedConflictPaymentId ? { ...group, state: "resolved", status: "resolved" } : group));
      if (conflictFilter === "unresolved") {
        setConflictPagination((current) => ({ ...current, total: Math.max(0, (current.total || 0) - 1), total_pages: Math.max(0, Math.ceil(Math.max(0, (current.total || 0) - 1) / (current.page_size || PAGE_SIZE))) }));
        setUnresolvedTotal((current) => typeof current === "number" ? Math.max(0, current - 1) : current);
      }
      setMessage(`Conflict resolved: ${winnerName} selected as winner and ${loserCount} loser${loserCount === 1 ? "" : "s"} rejected.`);
    } catch (requestError) { setError(getErrorMessage(requestError, "Could not resolve this payment conflict")); } finally { setConflictActionLoading(false); }
  }

  if (registrationLoading) return <div className="mx-auto max-w-7xl p-6 text-gray-600">Checking volunteer signup…</div>;
  if (!registration?.registered) return <div className="mx-auto max-w-xl p-4 md:p-6"><div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-gray-900/5"><h1 className="text-2xl font-bold text-gray-900">Volunteer account required</h1><p className="mt-2 text-sm text-gray-600">This staff account is not registered in the verification table. Log out and use the approved volunteer signup flow first.</p></div></div>;

  const hasValidPaymentId = PAYMENT_ID_PATTERN.test(detail?.payment_id || "");
  const conflictMetadata = detail?.conflict || detail?.conflict_metadata || null;
  const requiresConflictReview = Boolean(detail?.conflict_review_required || conflictMetadata?.required || conflictMetadata?.review_required || conflictMetadata?.state === "unresolved" || conflictMetadata?.status === "unresolved");
  const matchingConflictPaymentId = conflictMetadata?.payment_id || detail?.payment_id;

  return <div className="mx-auto max-w-7xl p-4 md:p-6">
    <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between"><div><h1 className="text-2xl font-bold text-gray-900">Receipt verification</h1><p className="mt-1 text-sm text-gray-600">Review uploaded PDFs and save the final payment status.</p></div>{registration?.volunteer && <p className="text-sm text-gray-500">Signed up as <span className="font-medium text-gray-800">{registration.volunteer.name}</span></p>}</div>
    {message && <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}{error && <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    <div className="mb-4 flex flex-wrap gap-2 border-b border-gray-200"><button type="button" onClick={() => setTab("payments")} className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "payments" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500"}`}>All payments</button><button type="button" onClick={() => setTab("conflicts")} className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "conflicts" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500"}`}>Conflicts {typeof unresolvedTotal === "number" && <span className="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{unresolvedTotal}</span>}</button></div>
    {tab === "payments" ? <>
      <div className="mb-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5"><div className="flex flex-col gap-3 md:flex-row md:items-center"><label className="flex-1 text-sm font-medium text-gray-700">Search ticket, payment ID, participant, email, or team<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Start typing to filter…" className="mt-1 w-full rounded border p-2 font-normal" /></label><label className="text-sm font-medium text-gray-700 md:w-56">Ticket Type<select value={ticketTypeFilter} onChange={(event) => { setTicketTypeFilter(event.target.value); setPage(1); }} className="mt-1 w-full rounded border bg-white p-2 font-normal"><option value="all">All types</option><option value="HACKATHON">Hackathon</option><option value="TECHPASS">Tech Pass</option><option value="NONTECHPASS">Non-Tech Pass</option><option value="RACING">Racing</option><option value="WORKSHOP">Workshop</option></select></label><label className="text-sm font-medium text-gray-700 md:w-56">Status<select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="mt-1 w-full rounded border bg-white p-2 font-normal"><option value="all">All statuses</option>{PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></label></div></div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="rounded-lg bg-white shadow-sm ring-1 ring-gray-900/5">
          <div className="flex items-center justify-between border-b p-4">
            <div>
              <h2 className="font-semibold text-gray-900">Payments</h2>
              <p className="text-xs text-gray-500">{pagination.total} total submission{pagination.total === 1 ? "" : "s"}</p>
            </div>
            {listLoading && <span className="text-sm text-gray-500">Loading…</span>}
          </div>
          {items.length === 0 && !listLoading ? (
            <p className="p-6 text-sm text-gray-500">No submissions match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Ticket</th>
                    <th className="px-4 py-3">Participant</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => (
                    <tr
                      key={item.ticket_id}
                      onClick={() => setSelectedId(item.ticket_id)}
                      className={`cursor-pointer hover:bg-blue-50 ${selectedId === item.ticket_id ? "bg-blue-50" : ""}`}
                    >
                      <td className="max-w-[170px] px-4 py-3 align-top">
                        <div className="truncate font-mono text-xs text-gray-800" title={item.ticket_id}>{item.ticket_id}</div>
                        <div className="mt-1 text-xs text-gray-500">{item.ticket_type} · {formatAmount(item.amount_paid)}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-gray-900">{item.participant_name}</div>
                        <div className="truncate text-xs text-gray-500">{item.participant_email}</div>
                      </td>
                      <td className="px-4 py-3 align-top"><StatusBadge status={item.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination pagination={pagination} page={page} loading={listLoading} onPageChange={setPage} noun="submissions" />
        </section>
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5">{!selectedId && <p className="py-10 text-center text-sm text-gray-500">Select a payment to view its receipt and events.</p>}{selectedId && detail && <div><div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs uppercase tracking-wide text-gray-500">Ticket ID</p><p className="break-all font-mono text-sm text-gray-900">{detail.ticket_id}</p><p className="mt-2 text-sm text-gray-500">Created {formatDate(detail.created_at)}</p></div><StatusBadge status={detail.status} /></div><ReviewSummary submission={detail} /><div className="mt-6"><h3 className="font-semibold text-gray-900">Receipt PDF</h3><div className="mt-2 rounded border bg-gray-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-gray-500">Payment ID</p>{hasValidPaymentId && <p className="mt-1 break-all font-mono text-sm text-gray-900">{detail.payment_id}</p>}{detail.payment_id === "queued" && detail.status === "NotVerified" && detail.s3_url && <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input value={manualPaymentId} onChange={(event) => setManualPaymentId(event.target.value)} placeholder="pay_ followed by 14 letters or digits" aria-label="Manual payment ID" className="min-w-0 flex-1 rounded border bg-white p-2 font-mono text-sm" /><button type="button" disabled={paymentIdLoading || !PAYMENT_ID_PATTERN.test(manualPaymentId)} onClick={savePaymentId} className="rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">{paymentIdLoading ? "Saving…" : "Save payment ID"}</button></div>}{detail.payment_id === "queued" && (!detail.s3_url || detail.status !== "NotVerified") && <p className="mt-1 text-sm text-amber-700">Payment ID is still queued and cannot be edited in the current state.</p>}{detail.payment_id == null && <p className="mt-1 text-sm text-red-700">Payment ID is not in the queued state and cannot be edited.</p>}{detail.payment_id != null && detail.payment_id !== "queued" && !hasValidPaymentId && <p className="mt-1 text-sm text-red-700">The stored payment ID has an unexpected format and cannot be edited here.</p>}{manualEntryError && <p className="mt-2 text-sm text-red-700">{manualEntryError}</p>}</div><ReceiptPreview submission={detail} showHeading={false} /></div>{requiresConflictReview ? <div className="mt-6 border-t pt-4"><p className="text-sm text-amber-800">This payment is part of a conflict group. Individual accept/reject actions are disabled until the group is reviewed.</p><button type="button" onClick={() => openConflictGroup(matchingConflictPaymentId)} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">Open conflict group</button></div> : detail.status === "NotVerified" ? <div className="mt-6 border-t pt-4">{!hasValidPaymentId && <p className="mb-3 text-sm text-amber-700">A valid payment ID is required before this payment can be accepted.</p>}<div className="flex flex-wrap gap-3"><button type="button" disabled={actionLoading || !hasValidPaymentId} onClick={() => decide("Accepted")} className="rounded bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60">{actionLoading ? "Saving…" : "Accept"}</button><button type="button" disabled={actionLoading} onClick={() => decide("Rejected")} className="rounded bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60">{actionLoading ? "Saving…" : "Reject"}</button></div></div> : <p className="mt-6 border-t pt-4 text-sm text-gray-500">This payment is no longer awaiting a volunteer decision.</p>}<DecisionHistory logs={detail.verification_logs} /></div>}</section></div>
    </> : <>
      <div className="mb-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5"><div className="flex flex-col gap-3 md:flex-row md:items-end"><label className="flex-1 text-sm font-medium text-gray-700">Search payment ID, ticket, participant, or team<input value={conflictSearch} onChange={(event) => { setConflictSearch(event.target.value); setConflictPage(1); }} placeholder="Search conflict groups…" className="mt-1 w-full rounded border p-2 font-normal" /></label><div className="flex gap-2"><button type="button" onClick={() => { setConflictFilter("unresolved"); setConflictPage(1); }} className={`rounded px-3 py-2 text-sm font-semibold ${conflictFilter === "unresolved" ? "bg-blue-600 text-white" : "border text-gray-700"}`}>Unresolved</button><button type="button" onClick={() => { setConflictFilter("resolved"); setConflictPage(1); }} className={`rounded px-3 py-2 text-sm font-semibold ${conflictFilter === "resolved" ? "bg-blue-600 text-white" : "border text-gray-700"}`}>Resolved history</button><button type="button" disabled={conflictListLoading} onClick={() => setConflictRefreshVersion((current) => current + 1)} className="rounded border px-3 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">Refresh</button></div></div></div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"><section className="rounded-lg bg-white shadow-sm ring-1 ring-gray-900/5"><div className="flex items-center justify-between border-b p-4"><div><h2 className="font-semibold text-gray-900">{conflictFilter === "unresolved" ? "Unresolved conflicts" : "Resolved conflict history"}</h2><p className="text-xs text-gray-500">{conflictPagination.total || 0} group{conflictPagination.total === 1 ? "" : "s"}</p></div>{conflictListLoading && <span className="text-sm text-gray-500">Loading…</span>}</div>{conflictGroups.length === 0 && !conflictListLoading ? <p className="p-6 text-sm text-gray-500">No conflict groups match this filter.</p> : <div className="divide-y divide-gray-100">{conflictGroups.map((group, index) => { const paymentId = group.payment_id || group.paymentId || group.id || group.conflict_id; const candidateCount = group.candidate_count || group.candidates_count || group.candidates?.length; return <button type="button" key={paymentId || index} onClick={() => setSelectedConflictPaymentId(paymentId)} className={`block w-full p-4 text-left hover:bg-blue-50 ${selectedConflictPaymentId === paymentId ? "bg-blue-50" : ""}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-all font-mono text-xs text-gray-800">{paymentId || "Unknown payment"}</p><p className="mt-1 text-sm font-medium text-gray-900">{group.participant_name || group.team_name || group.display_name || "Payment conflict"}</p><p className="mt-1 text-xs text-gray-500">{candidateCount || 0} candidate{candidateCount === 1 ? "" : "s"} · Updated {formatDate(group.updated_at || group.created_at)}</p></div><StatusBadge status={group.state || group.status || (conflictFilter === "resolved" ? "Resolved" : "Unresolved")} /></div></button>; })}</div>}<Pagination pagination={conflictPagination} page={conflictPage} loading={conflictListLoading} onPageChange={setConflictPage} noun="groups" /></section>
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5">{!selectedConflictPaymentId && <p className="py-10 text-center text-sm text-gray-500">Select a conflict group to review all candidate payments.</p>}{selectedConflictPaymentId && conflictDetailLoading && <p className="py-10 text-center text-sm text-gray-500">Loading conflict candidates…</p>}{selectedConflictPaymentId && !conflictDetailLoading && conflictDetail && <div><div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs uppercase tracking-wide text-gray-500">Conflict payment ID</p><p className="break-all font-mono text-sm text-gray-900">{conflictDetail.payment_id || selectedConflictPaymentId}</p><p className="mt-2 text-sm text-gray-500">{conflictResolved ? "Resolved conflict" : "Review every candidate before resolving"}</p></div><StatusBadge status={conflictDetail.state || (conflictResolved ? "Resolved" : "Unresolved")} /></div>{hasMissingReceipt && <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Every candidate must have a receipt URL before this conflict can be resolved.</div>}<div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">{conflictCandidates.map((candidate, index) => { const ticketId = getCandidateTicketId(candidate); return <CandidateCard key={ticketId || index} candidate={candidate} selected={conflictWinnerId === ticketId} locked={Boolean(acceptedTicketId && acceptedTicketId === ticketId)} disabled={!conflictResolutionAllowed || conflictActionLoading} onSelect={setConflictWinnerId} />; })}</div>{conflictCandidates.length === 0 && <p className="py-8 text-center text-sm text-gray-500">No candidates were returned for this conflict.</p>}<div className="mt-6 border-t pt-4"><button type="button" disabled={!conflictResolutionAllowed || !conflictWinnerId || conflictActionLoading || conflictCandidates.length < 2} onClick={resolveConflict} className="rounded bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">{conflictActionLoading ? "Resolving…" : conflictResolved ? "Conflict resolved" : "Confirm winner"}</button>{!conflictResolved && conflictDetail?.resolution_allowed === false && <p className="mt-2 text-sm text-amber-700">This conflict is not currently eligible for resolution.</p>}</div></div>}</section></div>
    </>}
  </div>;
}

export default ReceiptReviewPage;
