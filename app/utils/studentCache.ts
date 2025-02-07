// studentCache.ts
interface Student {
  studentId: string;
  studentName: string;
}

let cachedStudents: Student[] | null = null;
let lastFetchTime: number = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 saat

export const getStudents = async (): Promise<Student[]> => {
  try {
    const response = await fetch('/api/students'); // API endpoint kontrolü
    return await response.json();
  } catch (error) {
    console.error('Öğrenci listesi alınamadı:', error);
    return [];
  }
};