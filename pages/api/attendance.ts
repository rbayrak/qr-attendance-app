import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

// Delay fonksiyonu
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ResponseData = {
  success?: boolean;
  error?: string;
  debug?: any;
  blockedStudentId?: string;
};

// IP ve öğrenci eşleştirmelerini tutmak için
const ipAttendanceMap = new Map<string, {
  studentId: string;
  timestamp: number;
  firstStudentId?: string;
}>();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { studentId, week, clientIP } = req.body;

    if (!studentId || !week) {
      return res.status(400).json({ error: 'Öğrenci ID ve hafta bilgisi gerekli' });
    }

    const ip = clientIP || 
               req.headers['x-forwarded-for']?.toString() || 
               req.socket.remoteAddress || 
               'unknown';

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const existingAttendance = ipAttendanceMap.get(ip);
    if (existingAttendance) {
      if (existingAttendance.timestamp >= today.getTime()) {
        const firstStudentId = existingAttendance.firstStudentId || existingAttendance.studentId;
        if (studentId !== firstStudentId) {
          return res.status(403).json({ 
            error: 'Bu IP adresi bugün başka bir öğrenci için kullanılmış',
            blockedStudentId: firstStudentId 
          });
        }
      } else {
        ipAttendanceMap.set(ip, {
          studentId,
          timestamp: Date.now(),
          firstStudentId: studentId
        });
      }
    } else {
      ipAttendanceMap.set(ip, {
        studentId,
        timestamp: Date.now(),
        firstStudentId: studentId
      });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const weekColumn = String.fromCharCode(68 + Number(week) - 1);
    
    await delay(500);

    // Öğrenci ID'sini kontrol et
    const studentResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'B:B',
    });

    if (!studentResponse.data.values) {
      return res.status(404).json({ error: 'Öğrenci listesi bulunamadı' });
    }

    const studentRowIndex = studentResponse.data.values.findIndex(row => row[0] === studentId);
    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }

    // Haftalık veriyi kontrol et
    const weekResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${weekColumn}:${weekColumn}`,
    });

    const weekData = weekResponse.data.values || [];
    const ipCheck = weekData.find(row => row[0] && row[0].includes(`(IP:${ip})`));
    
    if (ipCheck) {
      const ipRowIndex = weekData.findIndex(row => row[0] && row[0].includes(`(IP:${ip})`));
      if (ipRowIndex !== -1 && studentResponse.data.values[ipRowIndex]) {
        const existingStudentId = studentResponse.data.values[ipRowIndex][0];
        if (existingStudentId && existingStudentId !== studentId) {
          return res.status(403).json({ 
            error: 'Bu IP adresi bu hafta başka bir öğrenci için kullanılmış',
            blockedStudentId: existingStudentId 
          });
        }
      }
    }

    const studentRow = studentRowIndex + 1;

    if (week < 1 || week > 16) {
      return res.status(400).json({ error: 'Geçersiz hafta numarası' });
    }

    const range = `${weekColumn}${studentRow}`;

    await delay(500);

    // Yoklamayı kaydet
    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[`VAR (IP:${ip})`]]
      }
    });

    res.status(200).json({ 
      success: true,
      debug: {
        operationDetails: {
          ogrenciNo: studentId,
          bulunanSatir: studentRow,
          sutun: weekColumn,
          aralik: range,
          weekNumber: week,
          ip: ip,
        },
        updateResult: updateResult.data,
        ipCheck: {
          ip,
          timestamp: Date.now()
        }
      }
    });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message.includes('Quota exceeded')) {
      return res.status(429).json({
        error: 'Sistem şu anda yoğun, lütfen birkaç saniye sonra tekrar deneyin'
      });
    }
    
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      debug: 'debugInfo'
    });
  }
}