'use client';

import React, { useEffect } from 'react';

interface QrProjectorProps {
  qrImageSrc: string;
  onClose: () => void;
}

// Yansıtma için tam ekran QR: ekranda yalnızca QR ve küçük bir kapat butonu.
// QR'ın süresi dolmadan yenilenmesi üst bileşende yapılır; ekran açık kaldığı
// sürece QR geçerli kalır.
const QrProjector: React.FC<QrProjectorProps> = ({ qrImageSrc, onClose }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1000] bg-white flex items-center justify-center">
      <button
        onClick={onClose}
        className="absolute top-3 right-3 px-3 py-1 rounded-md bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 text-sm"
        aria-label="QR kodu kapat"
      >
        ✕ Kapat
      </button>
      <img
        src={qrImageSrc}
        alt="Yoklama QR Kodu"
        style={{ width: 'min(94vw, 94vh)', height: 'min(94vw, 94vh)', imageRendering: 'pixelated' }}
      />
    </div>
  );
};

export default QrProjector;
