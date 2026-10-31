'use client';
import { useEffect, useRef, useState } from 'react';
import { Dither, type DitherMode } from 'ditherwave';

interface Props {
  mode: DitherMode;
  palette: string[];
  resolution: number;
  animate: boolean;
  matrixSize: number;
}

export default function DropZone({ mode, palette, resolution, animate, matrixSize }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [kind, setKind] = useState<'image' | 'video' | null>(null);
  const [drag, setDrag] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const currentUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
  }, []);

  const onFile = (file: File) => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    const url = URL.createObjectURL(file);
    currentUrl.current = url;
    setSrc(url);
    setKind(file.type.startsWith('video') ? 'video' : 'image');
    setExportError(null);
  };

  const reset = () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
    setSrc(null);
    setKind(null);
    setExportError(null);
  };

  const downloadFrame = () => {
    const canvas = previewRef.current?.querySelector('canvas');
    if (!canvas) {
      setExportError('WebGL2 output is not available in this browser.');
      return;
    }

    // Let the renderer paint after a mode change or first upload before taking the snapshot.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      canvas.toBlob((blob) => {
        if (!blob) {
          setExportError('Could not export this frame. Try loading the file again.');
          return;
        }

        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = `ditherwave-${mode}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        setExportError(null);
      }, 'image/png');
    }));
  };

  return (
    <div>
      <div
        className={`dropzone ${drag ? 'dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          const file = event.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
      >
        {!src && (
          <div>
            <div style={{ fontSize: 22, fontFamily: 'var(--font-serif)', fontStyle: 'italic', marginBottom: 8, color: 'var(--fg)' }}>
              drop an image or video
            </div>
            <div style={{ marginBottom: 20 }}>png · jpg · mp4 · webm</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <label style={{ border: '1px solid var(--line)', padding: '10px 18px', cursor: 'pointer', fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase' }}>
                <input
                  type="file"
                  accept="image/*,video/*"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onFile(file);
                    event.target.value = '';
                  }}
                />
                choose file
              </label>
            </div>
          </div>
        )}

        {src && (
          <div className="dropzone-preview">
            {/* The key makes the engine re-read the source when image/video type changes. */}
            <div ref={previewRef} style={{ width: '100%', height: '100%' }}>
              <Dither
                key={`${kind}:${src}`}
                mode={mode}
                palette={palette}
                resolution={resolution}
                animate={animate}
                matrixSize={matrixSize as 2 | 4 | 8}
                preserveDrawingBuffer
                style={{ width: '100%', height: '100%' }}
              >
                {kind === 'video' && (
                  <video src={src} autoPlay muted loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
                {kind === 'image' && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </Dither>
            </div>
            <button
              onClick={downloadFrame}
              style={{
                position: 'absolute', top: 12, right: 74,
                fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.15em',
                textTransform: 'uppercase', padding: '8px 14px',
                background: 'rgba(13,12,10,0.8)', border: '1px solid var(--line)', color: 'var(--fg)', zIndex: 10,
              }}
            >
              save PNG
            </button>
            <button
              onClick={reset}
              style={{
                position: 'absolute', top: 12, right: 12,
                fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.15em',
                textTransform: 'uppercase', padding: '8px 14px',
                background: 'rgba(13,12,10,0.8)', border: '1px solid var(--line)', color: 'var(--fg)', zIndex: 10,
              }}
            >
              reset
            </button>
            {exportError && (
              <p role="alert" style={{ position: 'absolute', left: 12, bottom: 8, zIndex: 10, padding: '8px 10px', background: 'rgba(13,12,10,0.88)', color: 'var(--danger)', fontSize: 11 }}>
                {exportError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
