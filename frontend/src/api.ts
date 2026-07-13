export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:8000";

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

export type Knowledge = {
  behavior: string;
  documentation: string;
};

export type PdfKnowledgeResult = Knowledge & {
  extracted_text: string;
  extracted_chars: number;
  pages: number;
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

export type VectorSearchResult = {
  id: number;
  source: string;
  chunk_index: number;
  score: number;
  text: string;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getKnowledge() {
  return request<Knowledge>("/api/knowledge");
}

export function saveKnowledge(knowledge: Knowledge) {
  return request<Knowledge>("/api/knowledge", {
    method: "PUT",
    body: JSON.stringify(knowledge),
  });
}

export async function uploadKnowledgePdf(file: File, mode: "append" | "replace") {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(
    `${API_BASE_URL}/api/knowledge/pdf?mode=${encodeURIComponent(mode)}`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return response.json() as Promise<PdfKnowledgeResult>;
}

export async function uploadVectorStorePdf(file: File, mode: "append" | "replace") {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(
    `${API_BASE_URL}/api/vector-store/pdf?mode=${encodeURIComponent(mode)}`,
    {
      method: "POST",
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

export function searchVectorStore(query: string, limit = 4) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request<{ results: VectorSearchResult[] }>(
    `/api/vector-store/search?${params.toString()}`,
  );
}

export function getSignedUrl() {
  return request<{ signed_url: string }>("/api/elevenlabs/signed-url");
}

export function getConversationToken() {
  return request<{ token: string }>("/api/elevenlabs/conversation-token");
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
