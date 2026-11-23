import { Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { extractReceiptFields, ReceiptFields } from './receipt-extractor';

@Component({
  selector: 'app-receipt-scan',
  imports: [RouterLink],
  templateUrl: './receipt-scan.component.html',
  styleUrl: './receipt-scan.component.css',
})
export class ReceiptScanComponent implements OnDestroy {
  @ViewChild('cameraVideo') private cameraVideo?: ElementRef<HTMLVideoElement>;

  readonly selectedFile = signal<File | null>(null);
  readonly previewUrl = signal<string | null>(null);
  readonly rawText = signal('');
  readonly fields = signal<ReceiptFields>({ provider: '', reference: '', amount: '', currency: '', date: '' });
  readonly status = signal('Choose a receipt image or capture one with your camera.');
  readonly error = signal('');
  readonly progress = signal(0);
  readonly processing = signal(false);
  readonly cameraActive = signal(false);

  private worker?: {
    recognize(file: File): Promise<{ data: { text: string } }>;
    terminate(): Promise<unknown>;
  };
  private cameraStream?: MediaStream;

  get hasImage(): boolean {
    return this.selectedFile() !== null;
  }

  onFileSelected(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (file) this.selectFile(file);
    input.value = '';
  }

  selectFile(file: File): void {
    this.error.set('');
    if (!file.type.startsWith('image/')) {
      this.error.set('Choose a PNG, JPEG, or other supported image file.');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      this.error.set('This image is larger than 12 MB. Choose a smaller photo.');
      return;
    }
    this.revokePreview();
    this.selectedFile.set(file);
    this.previewUrl.set(URL.createObjectURL(file));
    this.rawText.set('');
    this.fields.set({ provider: '', reference: '', amount: '', currency: '', date: '' });
    this.status.set('Image ready. Run OCR to extract receipt details on this device.');
    this.progress.set(0);
    this.stopCamera();
  }

  async startCamera(): Promise<void> {
    this.error.set('');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('Camera access is unavailable in this browser. Use the image upload option instead.');
      return;
    }
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 }, height: { ideal: 1200 } },
      });
      this.cameraActive.set(true);
      const video = this.cameraVideo?.nativeElement;
      if (video) {
        video.srcObject = this.cameraStream;
        await video.play();
      }
    } catch {
      this.cameraActive.set(false);
      this.error.set('Camera permission was denied or no camera is available. You can still upload an image.');
      this.stopCamera();
    }
  }

  capturePhoto(): void {
    const video = this.cameraVideo?.nativeElement;
    if (!video || !video.videoWidth || !video.videoHeight) {
      this.error.set('The camera is not ready yet. Try again in a moment.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      this.error.set('This browser could not prepare the camera image.');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) this.selectFile(new File([blob], 'receipt-capture.jpg', { type: 'image/jpeg' }));
      else this.error.set('The camera image could not be captured.');
    }, 'image/jpeg', 0.92);
  }

  async runOcr(): Promise<void> {
    const file = this.selectedFile();
    if (!file || this.processing()) return;
    this.processing.set(true);
    this.error.set('');
    this.status.set('Preparing the on-device OCR engine…');
    this.progress.set(0);

    try {
      const { createWorker } = await import('tesseract.js');
      this.worker ??= await createWorker('eng', 1, {
        logger: (message) => {
          if (message.status === 'recognizing text') {
            this.progress.set(Math.round(message.progress * 100));
            this.status.set(`Reading receipt text · ${this.progress()}%`);
          }
        },
      });
      const result = await this.worker.recognize(file);
      const text = result.data.text.trim();
      this.rawText.set(text);
      this.fields.set(extractReceiptFields(text));
      this.progress.set(100);
      this.status.set(text ? 'Text extracted. Check every field before using it.' : 'No readable text found. Try a sharper, well-lit image.');
    } catch {
      this.status.set('OCR could not finish. Try another image or use the fields below.');
      this.error.set('The local OCR engine failed to process this image. Your image was not uploaded.');
    } finally {
      this.processing.set(false);
    }
  }

  updateField(field: keyof ReceiptFields, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    this.fields.update((current) => ({ ...current, [field]: target.value }));
  }

  clearImage(): void {
    this.revokePreview();
    this.selectedFile.set(null);
    this.rawText.set('');
    this.fields.set({ provider: '', reference: '', amount: '', currency: '', date: '' });
    this.progress.set(0);
    this.status.set('Choose a receipt image or capture one with your camera.');
    this.error.set('');
  }

  ngOnDestroy(): void {
    this.stopCamera();
    this.revokePreview();
    void this.worker?.terminate();
  }

  private stopCamera(): void {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = undefined;
    const video = this.cameraVideo?.nativeElement;
    if (video) video.srcObject = null;
    this.cameraActive.set(false);
  }

  private revokePreview(): void {
    const url = this.previewUrl();
    if (url) URL.revokeObjectURL(url);
    this.previewUrl.set(null);
  }
}
