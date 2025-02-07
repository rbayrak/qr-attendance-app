interface Student {
    studentId: string;
    studentName: string;
  }
  
  let cachedStudents: Student[] | null = null;
  let lastFetchTime: number = 0;
  const CACHE_DURATION = 1000 * 60 * 60; // 1 saat
  
  export const getStudents = async (token: string) => {
    const now = Date.now();
    if (cachedStudents && (now - lastFetchTime < CACHE_DURATION)) {
      return cachedStudents;
    }
  
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${process.env.NEXT_PUBLIC_SHEET_ID}/values/A:C`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await response.json();
    
    if (!data.values) {
      throw new Error('Geçersiz veri formatı');
    }
  
    cachedStudents = data.values.slice(1).map((row: string[]) => ({
      studentId: row[1]?.toString() || '',
      studentName: row[2]?.toString() || ''
    }));
    lastFetchTime = now;
    
    return cachedStudents;
};