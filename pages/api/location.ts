// pages/api/location.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { STATIC_CLASS_LOCATION } from '../../config/constants';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    return res.status(200).json(STATIC_CLASS_LOCATION);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}