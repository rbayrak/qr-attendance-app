// attendance.ts
import { google } from 'googleapis';
import type { NextApiRequest, NextApiResponse } from 'next';

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

    // IP adresini al (önce client'dan gelen, yoksa request'ten)
    const ip = clientIP || 
               req.headers['x-forwarded-for']?.toString() || 
               req.socket.remoteAddress || 
               'unknown';

    // Bugünün başlangıç timestamp'i
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Memory'de IP kontrolü
    const existingAttendance = ipAttendanceMap.get(ip);
    if (existingAttendance) {
      // Aynı gün kontrolü
      if (existingAttendance.timestamp >= today.getTime()) {
        // Aynı öğrenci mi kontrol et
        if (existingAttendance.studentId !== studentId) {
          return res.status(403).json({ 
            error: 'Bu IP adresi bugün başka bir öğrenci için kullanılmış',
            blockedStudentId: existingAttendance.studentId 
          });
        }
      } else {
        // Gün değişmiş, kaydı güncelle
        ipAttendanceMap.set(ip, {
          studentId,
          timestamp: Date.now()
        });
      }
    } else {
      // İlk kez yoklama alınıyor
      ipAttendanceMap.set(ip, {
        studentId,
        timestamp: Date.now()
      });
    }

    // Service Account yetkilendirmesi
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

    // Önce tüm verileri çek
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'A:Z', // Tüm sütunları al
    });

    const rows = response.data.values;
    if (!rows) {
      return res.status(404).json({ error: 'Veri bulunamadı' });
    }

    // Öğrenciyi bul ve satır numarasını al (1'den başlayarak)
    const studentRowIndex = rows.findIndex(row => row[1] === studentId);
    if (studentRowIndex === -1) {
      return res.status(404).json({ error: 'Öğrenci bulunamadı' });
    }

    // Excel'de IP kontrolü
    const weekColumnIndex = 3 + Number(week) - 1; // D sütunundan başlayarak
    const weekData = rows.map(row => row[weekColumnIndex]);
    const ipCheck = weekData.find(cell => cell && cell.includes(`(IP:${ip})`));
    
    if (ipCheck) {
      return res.status(403).json({ 
        error: 'Bu IP adresi ile başka bir öğrenci için yoklama alınmış',
        blockedStudentId: studentId 
      });
    }
    
    // Gerçek satır numarası (1'den başlar)
    const studentRow = studentRowIndex + 1;

    if (week < 1 || week > 16) {
      return res.status(400).json({ error: 'Geçersiz hafta numarası' });
    }

    // Hafta sütununu belirle (D'den başlayarak)
    const weekColumn = String.fromCharCode(68 + Number(week) - 1);
    
    // Güncelleme aralığını belirle
    const range = `${weekColumn}${studentRow}`;

    // Debug bilgilerini hazırla
    const debugInfo = {
      operationDetails: {
        ogrenciNo: studentId,
        bulunanSatir: studentRow,
        sutun: weekColumn,
        aralik: range,
        weekNumber: week,
        ip: ip,
        calculatedASCII: 68 + Number(week) - 1
      }
    };

    // Yoklamayı kaydet (IP ile birlikte)
    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: range,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[`VAR (IP:${ip})`]]
      }
    });

    // Başarılı yanıtta debug bilgilerini de gönder
    res.status(200).json({ 
      success: true,
      debug: {
        ...debugInfo,
        updateResult: updateResult.data,
        ipCheck: {
          ip,
          timestamp: Date.now()
        }
      }
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      debug: 'debugInfo'
    });
  }
}