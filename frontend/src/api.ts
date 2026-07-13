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
  return request<{ text: string }>("/api/knowledge");
}

export function saveKnowledge(text: string) {
  return request<{ text: string }>("/api/knowledge", {
    method: "PUT",
    body: JSON.stringify({ text }),
  });
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
