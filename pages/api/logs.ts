import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTeacher } from '@/utils/teacherAuth';
import { formatIstanbul } from '@/utils/time';

const MAX_LOGS = 500;
const MAX_LOG_LENGTH = 500;

let debugLogs: string[] = []; // In-memory log storage

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
  ) {
    if (req.method === 'GET') {
      // Loglar öğrenci adları içerir: yalnızca öğretmen okuyabilir
      if (!requireTeacher(req, res)) return;
      return res.status(200).json({ logs: debugLogs });
    }
    else if (req.method === 'POST') {
      const { log } = req.body;
      if (!log) {
        return res.status(400).json({ error: 'Log içeriği gerekli' });
      }
      // Her satırın başına İstanbul saatiyle tarih/saat eklenir
      debugLogs.push(`[${formatIstanbul(Date.now(), true)}] ${String(log).slice(0, MAX_LOG_LENGTH)}`);
      if (debugLogs.length > MAX_LOGS) {
        debugLogs = debugLogs.slice(-MAX_LOGS);
      }
      return res.status(200).json({ success: true });
    }
    else if (req.method === 'DELETE') {
      if (!requireTeacher(req, res)) return;
      debugLogs = []; // Tüm logları temizle
      return res.status(200).json({ success: true });
    }
    else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  }
