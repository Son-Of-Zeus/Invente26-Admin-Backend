import React, { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PAYMENT_STATUSES = ["PendingPayment", "NotVerified", "Accepted", "Rejected"];
const PAGE_SIZE = 25;

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
      {status}
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

function ReceiptReviewPage() {
  const { authAxios } = useAuth();
  const [registration, setRegistration] = useState(null);
  const [registrationLoading, setRegistrationLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [ticketTypeFilter, setTicketTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;

    async function loadRegistration() {
      setRegistrationLoading(true);
      try {
        const response = await authAxios.get("/receipt-review/volunteers/me");
        if (active) setRegistration(response.data);
      } catch (requestError) {
        if (active) setError(getErrorMessage(requestError, "Could not check volunteer signup"));
      } finally {
        if (active) setRegistrationLoading(false);
      }
    }

    loadRegistration();
    return () => {
      active = false;
    };
  }, [authAxios]);

  useEffect(() => {
    if (!registration?.registered) return undefined;
    let active = true;

    async function loadSubmissions() {
      setListLoading(true);
      setError(null);
      try {
        const response = await authAxios.get("/receipt-review/submissions", {
          params: {
            status: statusFilter === "all" ? undefined : statusFilter,
            ticket_type: ticketTypeFilter === "all" ? undefined : ticketTypeFilter,
            search: debouncedSearch || undefined,
            page,
            page_size: PAGE_SIZE,
          },
        });
        if (active) {
          setItems(response.data.items || []);
          setPagination(response.data.pagination || { page, page_size: PAGE_SIZE, total: 0, total_pages: 0 });
        }
      } catch (requestError) {
        if (active) setError(getErrorMessage(requestError, "Could not load receipt submissions"));
      } finally {
        if (active) setListLoading(false);
      }
    }

    loadSubmissions();
    return () => {
      active = false;
    };
  }, [authAxios, debouncedSearch, page, refreshVersion, registration, statusFilter, ticketTypeFilter]);

  useEffect(() => {
    if (!registration?.registered || !selectedId) {
      setDetail(null);
      return undefined;
    }
    let active = true;

    async function loadDetail() {
      setDetailLoading(true);
      try {
        const response = await authAxios.get(`/receipt-review/submissions/${selectedId}`);
        if (active) setDetail(response.data.submission || null);
      } catch (requestError) {
        if (active) setError(getErrorMessage(requestError, "Could not load receipt details"));
      } finally {
        if (active) setDetailLoading(false);
      }
    }

    loadDetail();
    return () => {
      active = false;
    };
  }, [authAxios, refreshVersion, registration, selectedId]);

  async function decide(status) {
    if (!selectedId || detail?.status !== "NotVerified") return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      await authAxios.patch(`/receipt-review/submissions/${selectedId}/decision`, { status });
      setMessage(`Payment marked ${status}.`);
      setRefreshVersion((current) => current + 1);
    } catch (requestError) {
      const currentStatus = requestError?.response?.data?.current_status;
      setError(currentStatus
        ? `${getErrorMessage(requestError)} Current status: ${currentStatus}.`
        : getErrorMessage(requestError, "Could not save the receipt decision"));
    } finally {
      setActionLoading(false);
    }
  }

  if (registrationLoading) {
    return <div className="mx-auto max-w-7xl p-6 text-gray-600">Checking volunteer signup…</div>;
  }

  if (!registration?.registered) {
    return (
      <div className="mx-auto max-w-xl p-4 md:p-6">
        <div className="rounded-lg bg-white p-6 shadow-sm ring-1 ring-gray-900/5">
          <h1 className="text-2xl font-bold text-gray-900">Volunteer account required</h1>
          <p className="mt-2 text-sm text-gray-600">
            This staff account is not registered in the verification table. Log out and use the approved volunteer signup flow first.
          </p>
        </div>
      </div>
    );
  }

  const events = detail?.events || [];
  const members = detail?.hackathon?.members || [];

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <div className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Receipt verification</h1>
          <p className="mt-1 text-sm text-gray-600">Review uploaded PDFs and save the final payment status.</p>
        </div>
        {registration?.volunteer && (
          <p className="text-sm text-gray-500">
            Signed up as <span className="font-medium text-gray-800">{registration.volunteer.name}</span>
          </p>
        )}
      </div>

      {message && <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="mb-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <label className="flex-1 text-sm font-medium text-gray-700">
            Search ticket, participant, email, or team
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Start typing to filter…"
              className="mt-1 w-full rounded border p-2 font-normal"
            />
          </label>
          <label className="text-sm font-medium text-gray-700 md:w-56">
            Ticket Type
            <select
              value={ticketTypeFilter}
              onChange={(event) => {
                setTicketTypeFilter(event.target.value);
                setPage(1);
              }}
              className="mt-1 w-full rounded border bg-white p-2 font-normal"
            >
              <option value="all">All types</option>
              <option value="HACKATHON">Hackathon</option>
              <option value="TECHPASS">Tech Pass</option>
              <option value="NONTECHPASS">Non-Tech Pass</option>
              <option value="RACING">Racing</option>
              <option value="WORKSHOP">Workshop</option>
            </select>
          </label>
          <label className="text-sm font-medium text-gray-700 md:w-56">
            Status
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(1);
              }}
              className="mt-1 w-full rounded border bg-white p-2 font-normal"
            >
              <option value="all">All statuses</option>
              {PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
        </div>
      </div>

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
          <div className="flex items-center justify-between border-t p-4 text-sm">
            <span className="text-gray-500">Page {pagination.page || page} of {pagination.total_pages || 0}</span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!pagination.total_pages || page >= pagination.total_pages || listLoading}
                onClick={() => setPage((current) => current + 1)}
                className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-900/5">
          {!selectedId && <p className="py-10 text-center text-sm text-gray-500">Select a payment to view its receipt and events.</p>}
          {selectedId && detailLoading && <p className="py-10 text-center text-sm text-gray-500">Loading payment details…</p>}
          {selectedId && !detailLoading && detail && (
            <div>
              <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">Ticket ID</p>
                  <p className="break-all font-mono text-sm text-gray-900">{detail.ticket_id}</p>
                  <p className="mt-2 text-sm text-gray-500">Created {formatDate(detail.created_at)}</p>
                </div>
                <StatusBadge status={detail.status} />
              </div>

              <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Participant" value={detail.participant_name} />
                <Field label="Email" value={detail.participant_email} />
                <Field label="Phone" value={detail.participant_phone} />
                <Field label="Institution" value={detail.participant_college_name} />
                <Field label="Ticket type" value={detail.ticket_type} />
                <Field label="Amount paid" value={formatAmount(detail.amount_paid)} />
                <Field label="Gender" value={detail.participant_gender} />
                <Field label="Year of study" value={detail.participant_year_of_study} />
              </dl>

              <div className="mt-6">
                <h3 className="font-semibold text-gray-900">Registered events</h3>
                {events.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-500">No events associated with this ticket.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {events.map((event) => (
                      <li key={event.event_id} className="rounded border bg-gray-50 p-3 text-sm">
                        <div className="font-medium text-gray-900">{event.name}</div>
                        <div className="mt-1 text-xs text-gray-500">{event.event_type} · {event.dept_name} · {formatDate(event.date)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detail.hackathon && (
                <div className="mt-6">
                  <h3 className="font-semibold text-gray-900">Hackathon team</h3>
                  <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Team" value={detail.hackathon.team_name} />
                    <Field label="Domain" value={detail.hackathon.domain} />
                    <Field label="Track" value={detail.hackathon.track} />
                    <Field label="Problem statement" value={detail.hackathon.ps_description} />
                  </dl>
                  <div className="mt-3 space-y-2">
                    {members.map((member) => (
                      <div key={member.member_id} className="rounded border p-3 text-sm">
                        <div className="font-medium text-gray-900">{member.name} {member.is_lead ? "(lead)" : ""}</div>
                        <div className="text-xs text-gray-500">{member.email} · {member.phno || "No phone"} · Year {member.year_of_study ?? "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6">
                <h3 className="font-semibold text-gray-900">Receipt PDF</h3>
                {detail.s3_url ? (
                  <div className="mt-2">
                    <iframe
                      title={`Receipt for ${detail.ticket_id}`}
                      src={detail.s3_url}
                      className="h-[420px] w-full rounded border bg-gray-100"
                    />
                    <a href={detail.s3_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline">
                      Open PDF in a new tab
                    </a>
                  </div>
                ) : (
                  <p className="mt-2 rounded bg-gray-50 p-3 text-sm text-gray-500">No receipt URL has been recorded yet.</p>
                )}
              </div>

              {detail.status === "NotVerified" ? (
                <div className="mt-6 flex flex-wrap gap-3 border-t pt-4">
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => decide("Accepted")}
                    className="rounded bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading ? "Saving…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => decide("Rejected")}
                    className="rounded bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading ? "Saving…" : "Reject"}
                  </button>
                </div>
              ) : (
                <p className="mt-6 border-t pt-4 text-sm text-gray-500">This payment is no longer awaiting a volunteer decision.</p>
              )}

              {detail.verification_logs?.length > 0 && (
                <div className="mt-6 border-t pt-4">
                  <h3 className="font-semibold text-gray-900">Decision history</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {detail.verification_logs.map((log) => (
                      <li key={log.log_id} className="rounded bg-gray-50 p-3">
                        <span className="font-medium">{log.action_taken}</span> by {log.volunteer_name || log.volunteer_email} · {formatDate(log.verif_time)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default ReceiptReviewPage;
