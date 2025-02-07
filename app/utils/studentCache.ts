// studentCache.ts
interface Student {
  studentId: string;
  studentName: string;
}

let cachedStudents: Student[] | null = null;
let lastFetchTime: number = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 saat

export const getStudents = async () => {
  const now = Date.now();
  if (cachedStudents && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedStudents;
  }

  const response = await fetch('/api/students');
  const students = await response.json();
  cachedStudents = students;
  lastFetchTime = now;
  
  return cachedStudents;
};