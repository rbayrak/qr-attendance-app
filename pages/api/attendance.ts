// attendance.ts
import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

type ResponseData = {
  success?: boolean;
  error?: string;
  debug?: any;
  blockedStudentId?: string;
  message?: string;
};

// IP ve öğrenci eşleştirmelerini tutmak için
const ipAttendanceMap = new Map<string, {
  studentId: string;
  timestamp: number;
  firstStudentId?: string;
}>();

const validateIP = (ip: string) => {
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipPattern.test(ip)) return false;
  return ip.split('.').every(num => {
    const n = parseInt(num);
    return n >= 0 && n <= 255;
  });
};

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

    if (!validateIP(ip)) {
      return res.status(400).json({ error: 'Geçersiz IP adresi' });
    }

    // Google Sheets işlemleri
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

    // Öğrenci kontrolü ve yoklama kaydı için batch request
    const [studentResponse, weekResponse] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: 'B:B',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${weekColumn}:${weekColumn}`,
      })
    ]);

    if (!studentResponse.data.values) {
      return res.status(404).json({ error: 'Öğrenci listesi bulunamadı' });
    }

    const studentRowIndex = studentResponse.data.values.findIndex(row => row[0] === studentId);
    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }

    const weekData = weekResponse.data.values || [];
    const existingAttendanceCell = weekData[studentRowIndex];

    // Eğer öğrenci zaten bu hafta yoklamaya katılmışsa, başarılı mesajı dön
    if (existingAttendanceCell && existingAttendanceCell[0] && existingAttendanceCell[0].includes('VAR')) {
      return res.status(200).json({ 
        success: true,
        message: 'Yoklamanız zaten alınmış'
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let existingAttendance = ipAttendanceMap.get(ip);
    
    // Günlük aynı IP kontrolü
    if (existingAttendance) {
      // Aynı gün kontrolü
      if (existingAttendance.timestamp >= today.getTime()) {
        const firstStudentId = existingAttendance.firstStudentId || existingAttendance.studentId;
        if (studentId !== firstStudentId) {
          return res.status(403).json({ 
            error: 'Bu IP adresi bugün başka bir öğrenci için kullanılmış',
            blockedStudentId: firstStudentId 
          });
        }
      } else {
        // Gün değişmiş, yeni gün için kayıt güncelle
        existingAttendance.studentId = studentId;
        existingAttendance.timestamp = Date.now();
        existingAttendance.firstStudentId = studentId;
      }
    } else {
      // İlk kez yoklama alınıyor
      existingAttendance = {
        studentId,
        timestamp: Date.now(),
        firstStudentId: studentId
      };
      ipAttendanceMap.set(ip, existingAttendance);
    }

    // Excel'de IP kontrolü
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

    // Yoklamayı kaydet
    const batchUpdate = {
      spreadsheetId: process.env.SPREADSHEET_ID,
      resource: {
        valueInputOption: 'RAW',
        data: [{
          range: range,
          values: [[`VAR (IP:${ip})`]]
        }]
      }
    };

    const updateResult = await sheets.spreadsheets.values.batchUpdate(batchUpdate);

    res.status(200).json({ 
      success: true,
      message: 'Yoklamanız başarıyla kaydedildi',
      debug: {
        operationDetails: {
          ogrenciNo: studentId,
          bulunanSatir: studentRow,
          sutun: weekColumn,
          aralik: range,
          weekNumber: week,
          ip: ip
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
    
    if (error instanceof Error) {
      if (error.message.includes('Quota exceeded')) {
        return res.status(429).json({
          error: 'Sistem yoğun, lütfen daha sonra tekrar deneyin'
        });
      } else if (error.message.includes('Rate limit exceeded')) {
        return res.status(429).json({
          error: 'API limit aşıldı'
        });
      }
    }
    
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};