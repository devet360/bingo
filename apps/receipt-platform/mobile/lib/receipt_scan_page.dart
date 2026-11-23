import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image_picker/image_picker.dart';

import 'receipt_fields.dart';

class ReceiptScanPage extends StatefulWidget {
  const ReceiptScanPage({super.key});

  @override
  State<ReceiptScanPage> createState() => _ReceiptScanPageState();
}

class _ReceiptScanPageState extends State<ReceiptScanPage> {
  final _picker = ImagePicker();
  final _recognizer = TextRecognizer(script: TextRecognitionScript.latin);
  final _referenceController = TextEditingController();
  final _amountController = TextEditingController();
  final _currencyController = TextEditingController();
  final _dateController = TextEditingController();

  XFile? _image;
  ReceiptFields _fields = const ReceiptFields();
  String _status = 'Capture a receipt or choose one from your photos.';
  String _recognizedText = '';
  String? _error;
  bool _processing = false;

  Future<void> _pickImage(ImageSource source) async {
    setState(() {
      _error = null;
      _status = 'Opening image…';
    });
    try {
      final image = await _picker.pickImage(
        source: source,
        imageQuality: 92,
        maxWidth: 2200,
        requestFullMetadata: false,
      );
      if (image == null || !mounted) return;
      final length = await image.length();
      if (length > 12 * 1024 * 1024) {
        setState(() {
          _error = 'Choose an image smaller than 12 MB.';
          _status = 'Image is too large.';
        });
        return;
      }
      setState(() {
        _image = image;
        _recognizedText = '';
        _fields = const ReceiptFields();
        _referenceController.clear();
        _amountController.clear();
        _currencyController.clear();
        _dateController.clear();
        _status = 'Image ready. Extract text on this device.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Camera or photo access failed. Check the app permissions and try again.';
        _status = 'Could not open the image.';
      });
    }
  }

  Future<void> _recognize() async {
    final image = _image;
    if (image == null || _processing) return;
    setState(() {
      _processing = true;
      _error = null;
      _status = 'Reading receipt text locally…';
    });
    try {
      final input = InputImage.fromFilePath(image.path);
      final recognized = await _recognizer.processImage(input);
      if (!mounted) return;
      final text = recognized.text.trim();
      final fields = extractReceiptFields(text);
      setState(() {
        _recognizedText = text;
        _fields = fields;
        _referenceController.text = fields.reference;
        _amountController.text = fields.amount;
        _currencyController.text = fields.currency;
        _dateController.text = fields.date;
        _status = text.isEmpty
            ? 'No readable text found. Try a sharper image with even lighting.'
            : 'Text extracted. Verify every value before continuing.';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'On-device OCR could not read this image. Try another photo.';
        _status = 'OCR could not finish.';
      });
    } finally {
      if (mounted) setState(() => _processing = false);
    }
  }

  void _clear() {
    setState(() {
      _image = null;
      _recognizedText = '';
      _fields = const ReceiptFields();
      _referenceController.clear();
      _amountController.clear();
      _currencyController.clear();
      _dateController.clear();
      _error = null;
      _status = 'Capture a receipt or choose one from your photos.';
    });
  }

  @override
  void dispose() {
    unawaited(_recognizer.close());
    _referenceController.dispose();
    _amountController.dispose();
    _currencyController.dispose();
    _dateController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image = _image;
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          children: [
            Icon(Icons.verified_outlined, color: Color(0xFF2C8054)),
            SizedBox(width: 9),
            Text('Verity'),
          ],
        ),
        actions: [IconButton(onPressed: image == null ? null : _clear, tooltip: 'Remove image', icon: const Icon(Icons.delete_outline))],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 32),
          children: [
            Text('RECEIPT INTAKE', style: Theme.of(context).textTheme.labelSmall?.copyWith(letterSpacing: 1.6, color: const Color(0xFF49876A), fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text('Scan and review', style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w600, letterSpacing: -1)),
            const SizedBox(height: 8),
            Text('Extract transaction details from a photo. OCR runs on this device; your image is not uploaded.', style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: const Color(0xFF64756B), height: 1.45)),
            const SizedBox(height: 22),
            Container(
              height: 250,
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(color: const Color(0xFFEAF1EB), borderRadius: BorderRadius.circular(14), border: Border.all(color: const Color(0xFFDCE7DE))),
              child: image == null
                  ? const Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.document_scanner_outlined, size: 38, color: Color(0xFF6B9E7C)), SizedBox(height: 10), Text('Your receipt preview appears here')]))
                  : Image.file(File(image.path), fit: BoxFit.contain),
            ),
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: _processing ? null : () => _pickImage(ImageSource.camera), icon: const Icon(Icons.camera_alt_outlined), label: const Text('Take photo'))),
              const SizedBox(width: 10),
              Expanded(child: OutlinedButton.icon(onPressed: _processing ? null : () => _pickImage(ImageSource.gallery), icon: const Icon(Icons.photo_library_outlined), label: const Text('Choose image'))),
            ]),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: image == null || _processing ? null : _recognize,
              icon: _processing ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.document_scanner_outlined),
              label: Text(_processing ? 'Reading receipt…' : 'Extract receipt details'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48), backgroundColor: const Color(0xFF1B5137)),
            ),
            const SizedBox(height: 10),
            Semantics(liveRegion: true, child: Text(_status, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: const Color(0xFF65786C)))),
            if (_error != null) ...[const SizedBox(height: 8), Text(_error!, style: const TextStyle(color: Color(0xFF9C3333)))],
            const SizedBox(height: 22),
            Text('Review extracted details', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _fields.provider.isEmpty ? null : _fields.provider,
              decoration: const InputDecoration(labelText: 'Provider'),
              items: const [DropdownMenuItem(value: 'cbe', child: Text('Commercial Bank of Ethiopia')), DropdownMenuItem(value: 'telebirr', child: Text('Telebirr')), DropdownMenuItem(value: 'mpesa', child: Text('M-Pesa')), DropdownMenuItem(value: 'boa', child: Text('Bank of Abyssinia')), DropdownMenuItem(value: 'dashen', child: Text('Dashen Bank')), DropdownMenuItem(value: 'awash', child: Text('Awash Bank')), DropdownMenuItem(value: 'cbebirr', child: Text('CBE Birr')), DropdownMenuItem(value: 'ebirr', child: Text('eBirr')), DropdownMenuItem(value: 'other', child: Text('Other / unknown'))],
              onChanged: (value) => setState(() => _fields = ReceiptFields(provider: value ?? '', reference: _fields.reference, amount: _fields.amount, currency: _fields.currency, date: _fields.date)),
            ),
            const SizedBox(height: 12),
            TextField(controller: _referenceController, decoration: const InputDecoration(labelText: 'Transaction reference'), textCapitalization: TextCapitalization.characters),
            const SizedBox(height: 12),
            Row(children: [Expanded(child: TextField(controller: _amountController, decoration: const InputDecoration(labelText: 'Amount'), keyboardType: const TextInputType.numberWithOptions(decimal: true))), const SizedBox(width: 10), SizedBox(width: 94, child: TextField(controller: _currencyController, decoration: const InputDecoration(labelText: 'Currency'), textCapitalization: TextCapitalization.characters))]),
            const SizedBox(height: 12),
            TextField(controller: _dateController, decoration: const InputDecoration(labelText: 'Transaction date')),
            if (_recognizedText.isNotEmpty) ...[const SizedBox(height: 14), ExpansionTile(title: const Text('View recognized text'), tilePadding: EdgeInsets.zero, children: [SelectableText(_recognizedText)])],
            const SizedBox(height: 18),
            Container(padding: const EdgeInsets.all(14), decoration: BoxDecoration(color: const Color(0xFFFFFAF2), border: Border.all(color: const Color(0xFFF0DFC2)), borderRadius: BorderRadius.circular(12)), child: const Text('OCR is only extraction. A screenshot cannot verify a payment; a supported authoritative provider must confirm the transaction.', style: TextStyle(height: 1.45, color: Color(0xFF715D3B)))),
          ],
        ),
      ),
    );
  }
}
