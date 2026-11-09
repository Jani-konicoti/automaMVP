export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:8001`
    : window.location.origin);

export type Appointment = {
  id: number;
  customer_name: string;
  phone?: string | null;
  date: string;
  time: string;
  notes?: string | null;
  created_at: string;
};

export type AppointmentInput = {
  customer_name: string;
  date: string;
  time: string;
  phone?: string | null;
  notes?: string | null;
};

export type OutboundContact = {
  id: number;
  reference: string;
  phone: string;
  created_at: string;
  updated_at: string;
};

export type OutboundContactInput = {
  reference: string;
  phone: string;
};

export type OutboundCall = {
  id: number;
  contact_id?: number | null;
  reference: string;
  phone: string;
  agent_id: string;
  agent_phone_number_id?: string | null;
  source?: string | null;
  conversation_id?: string | null;
  call_sid?: string | null;
  status: string;
  transcript: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type OutboundCallInput = {
  contact_id: number;
  agent_id: string;
  agent_phone_number_id: string;
  source?: string | null;
};

export type OutboundCampaignItem = {
  id: number;
  position: number;
  contact_id?: number | null;
  reference: string;
  phone: string;
  status: "pending" | "calling" | "completed" | "failed" | "cancelled";
  outbound_call_id?: number | null;
  conversation_id?: string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

export type OutboundCampaign = {
  id: number;
  status: "queued" | "running" | "completed" | "cancelled";
  total_count: number;
  completed_count: number;
  failed_count: number;
  agent_id: string;
  agent_phone_number_id: string;
  source?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  items: OutboundCampaignItem[];
};

export type OutboundCampaignPage = {
  items: OutboundCampaign[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

export type OutboundCampaignInput = {
  contact_ids: number[];
  agent_id: string;
  agent_phone_number_id: string;
  source?: string | null;
};

export type ElevenLabsPhoneNumber = {
  phone_number_id: string;
  label: string;
  phone_number: string;
  provider: string;
  supports_outbound: boolean;
};

export type Knowledge = {
  behavior: string;
  documentation: string;
};

export type ElevenLabsAgent = {
  id: number;
  name: string;
  agent_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ElevenLabsConfig = {
  api_key: string;
  agents: ElevenLabsAgent[];
  active_agent_id?: string | null;
  inbound_agent_id?: string | null;
  outbound_agent_id?: string | null;
  presentation_agent_id?: string | null;
  inbound_source?: string | null;
  outbound_source?: string | null;
  presentation_source?: string | null;
  public_base_url: string;
  tool_webhook_secret: string;
  post_call_webhook_secret: string;
  configured: boolean;
};

export type ElevenLabsDefaults = {
  inbound_agent_id: string | null;
  outbound_agent_id: string | null;
  presentation_agent_id: string | null;
};

export type ElevenLabsAgentInput = {
  name: string;
  agent_id: string;
};

export type ElevenLabsIntegrationInput = {
  public_base_url: string;
  post_call_webhook_secret: string;
};

export type VectorStoreStats = {
  chunks: number;
  sources: number;
};

export type VectorStorePdfResult = VectorStoreStats & {
  source: string;
  pages: number;
  extracted_chars: number;
};

export type VectorStoreSource = {
  source: string;
  chunks: number;
  chars: number;
  preview: string;
};

export type KnowledgeDocument = VectorStoreSource & {
  id: number;
  position: number;
  module_id: number | null;
};

export type KnowledgeModule = {
  id: number;
  area_id: number;
  name: string;
  position: number;
  documents: KnowledgeDocument[];
};

export type KnowledgeArea = {
  id: number;
  name: string;
  position: number;
  modules: KnowledgeModule[];
};

export type KnowledgeTree = {
  areas: KnowledgeArea[];
  unassigned_documents: KnowledgeDocument[];
};

export type VectorSearchResult = {
  id: number;
  source: string;
  chunk_index: number;
  score: number;
  text: string;
};

export type AuthUser = {
  id: number;
  username: string;
  role: "superadmin" | "admin" | "user";
  can_inbound: boolean;
  can_outbound: boolean;
  can_presentation: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  tenant_id: number;
  tenant_name: string;
};

export type Tenant = {
  id: number;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type UsageEvent = {
  id: number;
  operator_username?: string | null;
  channel: "inbound" | "outbound" | "presentation";
  origin: "web" | "phone";
  conversation_id?: string | null;
  agent_id?: string | null;
  source?: string | null;
  status: string;
  duration_seconds: number;
  started_at: string;
  completed_at?: string | null;
};

export type UsageChannelStats = {
  channel: UsageEvent["channel"];
  sessions: number;
  completed: number;
  failed: number;
  duration_seconds: number;
  average_duration_seconds: number;
};

export type UsageDailyStats = {
  date: string;
  inbound: number;
  outbound: number;
  presentation: number;
};

export type UsageReport = {
  tenant_id: number;
  tenant_name: string;
  days: number;
  channels: UsageChannelStats[];
  daily: UsageDailyStats[];
  events: UsageEvent[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

export type ContactImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
};

export type UserCreateInput = {
  username: string;
  password: string;
  role: "admin" | "user";
  can_inbound: boolean;
  can_outbound: boolean;
  can_presentation: boolean;
};

export type UserUpdateInput = Omit<UserCreateInput, "password"> & {
  is_active: boolean;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const embeddedPresentation = window.location.pathname.replace(/\/$/, "") === "/presentazione-cpeople";
  const selectedTenant = embeddedPresentation ? "1" : localStorage.getItem("cp-agent-tenant-id");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(selectedTenant ? { "X-Tenant-ID": selectedTenant } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    if (response.status === 401 && path !== "/api/auth/login") {
      window.dispatchEvent(new Event("jk-auth-expired"));
    }
    const body = await response.text();
    let message = body || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      message = parsed.detail || message;
    } catch {
      // Keep the raw response when it is not JSON.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export function getKnowledge() {
  return request<Knowledge>("/api/knowledge");
}

export function getElevenLabsConfig() {
  return request<ElevenLabsConfig>("/api/elevenlabs/config");
}

export function saveElevenLabsConfig(api_key: string) {
  return request<ElevenLabsConfig>("/api/elevenlabs/config", {
    method: "PUT",
    body: JSON.stringify({ api_key }),
  });
}

export function saveElevenLabsDefaults(defaults: ElevenLabsDefaults) {
  return request<ElevenLabsConfig>("/api/elevenlabs/config/defaults", {
    method: "PUT",
    body: JSON.stringify(defaults),
  });
}

export function saveElevenLabsIntegration(input: ElevenLabsIntegrationInput) {
  return request<ElevenLabsConfig>("/api/elevenlabs/config/integration", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function saveFlowSource(
  flow: "centralino-entrata" | "centralino-uscita" | "presentazione",
  source: string | null,
) {
  return request<ElevenLabsConfig>("/api/elevenlabs/config/source", {
    method: "PUT",
    body: JSON.stringify({ flow, source }),
  });
}

export function createElevenLabsAgent(input: ElevenLabsAgentInput) {
  return request<ElevenLabsAgent>("/api/elevenlabs/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateElevenLabsAgent(id: number, input: ElevenLabsAgentInput) {
  return request<ElevenLabsAgent>(`/api/elevenlabs/agents/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteElevenLabsAgent(id: number) {
  return request<ElevenLabsConfig>(`/api/elevenlabs/agents/${id}`, {
    method: "DELETE",
  });
}

export async function uploadVectorStorePdf(file: File, mode: "append" | "replace") {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(
    `${API_BASE_URL}/api/vector-store/pdf?mode=${encodeURIComponent(mode)}`,
    {
      method: "POST",
      credentials: "include",
      headers: localStorage.getItem("cp-agent-tenant-id")
        ? { "X-Tenant-ID": localStorage.getItem("cp-agent-tenant-id")! }
        : undefined,
      body: formData,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return response.json() as Promise<VectorStorePdfResult>;
}

export function getVectorStoreStats() {
  return request<VectorStoreStats>("/api/vector-store/stats");
}

export function getVectorStoreSources() {
  return request<VectorStoreSource[]>("/api/vector-store/sources");
}

export function getKnowledgeTree() {
  return request<KnowledgeTree>("/api/knowledge-tree");
}

export function createKnowledgeArea(name: string) {
  return request<KnowledgeTree>("/api/knowledge-tree/areas", { method: "POST", body: JSON.stringify({ name }) });
}

export function updateKnowledgeArea(id: number, name: string) {
  return request<KnowledgeTree>(`/api/knowledge-tree/areas/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
}

export function deleteKnowledgeArea(id: number) {
  return request<KnowledgeTree>(`/api/knowledge-tree/areas/${id}`, { method: "DELETE" });
}

export function createKnowledgeModule(areaId: number, name: string) {
  return request<KnowledgeTree>("/api/knowledge-tree/modules", { method: "POST", body: JSON.stringify({ area_id: areaId, name }) });
}

export function updateKnowledgeModule(id: number, areaId: number, name: string) {
  return request<KnowledgeTree>(`/api/knowledge-tree/modules/${id}`, { method: "PUT", body: JSON.stringify({ area_id: areaId, name }) });
}

export function deleteKnowledgeModule(id: number) {
  return request<KnowledgeTree>(`/api/knowledge-tree/modules/${id}`, { method: "DELETE" });
}

export function moveKnowledgeItem(kind: "areas" | "modules" | "documents", id: number, parentId: number | null, position: number) {
  return request<KnowledgeTree>(`/api/knowledge-tree/${kind}/${id}/move`, {
    method: "PUT",
    body: JSON.stringify({ parent_id: parentId, position }),
  });
}

export function searchVectorStore(query: string, limit = 4, source?: string | null) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (source) {
    params.set("source", source);
  }

  return request<{ results: VectorSearchResult[] }>(
    `/api/vector-store/search?${params.toString()}`,
  );
}

type VoiceFlow = "centralino-entrata" | "centralino-uscita" | "presentazione";

export function getSignedUrl(agentId: string | null | undefined, flow: VoiceFlow) {
  const params = new URLSearchParams();
  params.set("flow", flow);
  if (agentId) {
    params.set("agent_id", agentId);
  }

  return request<{ signed_url: string }>(
    `/api/elevenlabs/signed-url${params.size ? `?${params.toString()}` : ""}`,
  );
}

export function getConversationToken(agentId: string | null | undefined, flow: VoiceFlow) {
  const params = new URLSearchParams();
  params.set("flow", flow);
  if (agentId) {
    params.set("agent_id", agentId);
  }

  return request<{ token: string }>(
    `/api/elevenlabs/conversation-token${params.size ? `?${params.toString()}` : ""}`,
  );
}

export function listElevenLabsPhoneNumbers() {
  return request<ElevenLabsPhoneNumber[]>("/api/elevenlabs/phone-numbers");
}

export function createAppointment(input: AppointmentInput) {
  return request<Appointment>("/api/appointments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listAppointments() {
  return request<Appointment[]>("/api/appointments");
}

export function deleteAllAppointments() {
  return request<{ deleted: number }>("/api/appointments", {
    method: "DELETE",
  });
}

export function listOutboundContacts() {
  return request<OutboundContact[]>("/api/outbound-contacts");
}

export function createOutboundContact(input: OutboundContactInput) {
  return request<OutboundContact>("/api/outbound-contacts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOutboundContact(id: number, input: OutboundContactInput) {
  return request<OutboundContact>(`/api/outbound-contacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteOutboundContact(id: number) {
  return request<{ deleted: number }>(`/api/outbound-contacts/${id}`, {
    method: "DELETE",
  });
}

export async function importOutboundContacts(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const selectedTenant = localStorage.getItem("cp-agent-tenant-id");
  const response = await fetch(`${API_BASE_URL}/api/outbound-contacts/import`, {
    method: "POST",
    credentials: "include",
    headers: selectedTenant ? { "X-Tenant-ID": selectedTenant } : undefined,
    body: formData,
  });
  if (!response.ok) {
    const body = await response.text();
    try {
      throw new Error((JSON.parse(body) as { detail?: string }).detail || body);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(body || `HTTP ${response.status}`);
      throw error;
    }
  }
  return response.json() as Promise<ContactImportResult>;
}


export function startOutboundCall(input: OutboundCallInput) {
  return request<OutboundCall>("/api/outbound-calls", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listOutboundCalls() {
  return request<OutboundCall[]>("/api/outbound-calls");
}

export function deleteAllOutboundCalls() {
  return request<{ deleted: number }>("/api/outbound-calls", {
    method: "DELETE",
  });
}

export function createOutboundCampaign(input: OutboundCampaignInput) {
  return request<OutboundCampaign>("/api/outbound-campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getLatestOutboundCampaign() {
  return request<OutboundCampaign | null>("/api/outbound-campaigns/latest");
}

export function listOutboundCampaigns() {
  return request<OutboundCampaign[]>("/api/outbound-campaigns");
}

export function getOutboundCampaignHistory(page = 1, pageSize = 8) {
  return request<OutboundCampaignPage>(
    `/api/outbound-campaigns/history?page=${page}&page_size=${pageSize}`,
  );
}

export function getOutboundCampaignCalls(id: number) {
  return request<OutboundCall[]>(`/api/outbound-campaigns/${id}/calls`);
}

export function cancelOutboundCampaign(id: number) {
  return request<OutboundCampaign>(`/api/outbound-campaigns/${id}/cancel`, {
    method: "POST",
  });
}

export function deleteOutboundCampaign(id: number) {
  return request<{ deleted: number }>(`/api/outbound-campaigns/${id}`, {
    method: "DELETE",
  });
}

export function login(username: string, password: string) {
  return request<AuthUser>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export function getCurrentUser() {
  return request<AuthUser>("/api/auth/me");
}

export function changePassword(currentPassword: string, newPassword: string) {
  return request<{ ok: boolean }>("/api/auth/password", {
    method: "PUT",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

export function listUsers() {
  return request<AuthUser[]>("/api/users");
}

export function createUser(input: UserCreateInput) {
  return request<AuthUser>("/api/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateUser(id: number, input: UserUpdateInput) {
  return request<AuthUser>(`/api/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function resetUserPassword(id: number, password: string) {
  return request<{ ok: boolean }>(`/api/users/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

export function deleteUser(id: number) {
  return request<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" });
}

export function listTenants() {
  return request<Tenant[]>("/api/tenants");
}

export function createTenant(input: { name: string; slug: string }) {
  return request<Tenant>("/api/tenants", { method: "POST", body: JSON.stringify(input) });
}

export function updateTenant(id: number, input: { name: string; slug: string }) {
  return request<Tenant>(`/api/tenants/${id}`, { method: "PUT", body: JSON.stringify(input) });
}

export function deactivateTenant(id: number) {
  return request<{ ok: boolean }>(`/api/tenants/${id}`, { method: "DELETE" });
}

export function getUsageReport(days = 30, page = 1, channel?: UsageEvent["channel"] | "") {
  const params = new URLSearchParams({ days: String(days), page: String(page), page_size: "20" });
  if (channel) params.set("channel", channel);
  return request<UsageReport>(`/api/usage?${params.toString()}`);
}

export function startUsageSession(input: {
  channel: UsageEvent["channel"];
  origin?: UsageEvent["origin"];
  conversation_id?: string | null;
  agent_id?: string | null;
  source?: string | null;
}) {
  return request<UsageEvent>("/api/usage/sessions", { method: "POST", body: JSON.stringify(input) });
}

export function finishUsageSession(id: number, status: "completed" | "failed" | "cancelled" = "completed") {
  return request<UsageEvent>(`/api/usage/sessions/${id}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}
