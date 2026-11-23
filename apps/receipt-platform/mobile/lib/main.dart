import 'package:flutter/material.dart';

import 'receipt_scan_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const VerityMobileApp());
}

class VerityMobileApp extends StatelessWidget {
  const VerityMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xFF1D3029);
    const green = Color(0xFF1B5137);
    return MaterialApp(
      title: 'Verity Receipt Scan',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: green, brightness: Brightness.light),
        scaffoldBackgroundColor: const Color(0xFFF4F7F4),
        textTheme: ThemeData.light().textTheme.apply(bodyColor: ink, displayColor: ink),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFFDCE5DE)),
          ),
        ),
      ),
      home: const ReceiptScanPage(),
    );
  }
}
