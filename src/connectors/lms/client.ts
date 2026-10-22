import { LMS_ORIGIN } from "../../config";
import { AuthError, cookieHeader, silentRefresh } from "./session";

let refreshed = false;

export async function lms<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${LMS_ORIGIN}/api/micro-lms${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { accept: "application/json", cookie: cookieHeader(), ...(init.headers ?? {}) },
    redirect: "manual",
  });
  if (res.status === 401 || res.status === 302 || res.status === 303) {
    if (!refreshed && (await silentRefresh())) {
      refreshed = true;
      return lms(path, init);
    }
    throw new AuthError();
  }
  if (res.status === 204) return null as T;
  if (!res.ok) throw new Error(`LMS ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

// ---- API shapes (only fields we use) ----

export interface LmsCourse {
  id: number;
  name: string;
  isArchived: boolean;
  category: string;
  settings: { syllabusUrl: string | null; timeChannelUrl: string | null };
}

export interface LmsActivity {
  id: number;
  name: string;
  weight: number;
  exercisesCount: number;
  maxExercisesCount: number;
  averageScoreThreshold: number | null;
  isLateDaysEnabled: boolean;
  bestScoresCount: number | null;
}

export interface LmsOverview {
  id: number;
  name: string;
  themes: {
    id: number;
    name: string;
    order: number;
    publishDate: string | null;
    longreads: {
      id: number;
      name: string;
      exercises: { id: number; name: string; maxScore: number; activity: { id: number; name: string; weight: number }; deadline: string | null }[];
    }[];
  }[];
}

export interface LmsTask {
  id: number;
  state: "backlog" | "inProgress" | "submitted" | "review" | "evaluated" | "failed" | string;
  score: number | null;
  extraScore: number | null;
  deadline: string | null;
  submitAt: string | null;
  evaluateAt: string | null;
  lateDays: number | null;
  isLateDaysEnabled: boolean;
  exercise: { id: number; name: string; maxScore: number; activity: { id: number; name: string; weight: number } };
  course: { id: number; name: string };
  theme: { id: number; name: string };
  longread: { id: number; name: string };
}

export const api = {
  me: () => lms("/students/me"),
  courses: () => lms<{ items: LmsCourse[] }>("/courses/student?limit=100&offset=0&state=published"),
  overview: (id: number) => lms<LmsOverview>(`/courses/${id}/overview`),
  activities: (id: number) => lms<LmsActivity[]>(`/courses/${id}/activities`),
  progress: (id: number) => lms<{ earnedScore: number; leftToEarnScore: number; maxScore: number }>(`/courses/${id}/student/progress`),
  tasks: () => lms<LmsTask[]>("/tasks/student"),
  task: (id: number) => lms<any>(`/tasks/${id}`),
  materials: (longreadId: number) => lms<{ items: any[] }>(`/longreads/${longreadId}/materials?limit=10000`),
};
