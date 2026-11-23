package com.verity.platform.provider.cbe;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

class CbeReceiptParserTest {
  private static final String CBE_TEXT = String.join("\n",
      "PayerClaim On Bole Atlantic",
      "AccountE****0010",
      "ReceiverVERITY TEST LTD",
      "Account1****5909",
      "Payment Date & Time01-02-2026, 6:16:00 PM",
      "Reference No. (VAT Invoice No)FT26266ZN54F",
      "Transferred Amount1,200.00 ETB",
      "Total amount debited from customers account1,202.50 ETB");

  @Test
  void parsesCbeLegacyBranchReceiptLines() {
    var receipt = CbeReceiptParser.parseText(CBE_TEXT);

    assertThat(receipt.senderName()).isEqualTo("Claim On Bole Atlantic");
    assertThat(receipt.senderAccount()).isEqualTo("E****0010");
    assertThat(receipt.receiverName()).isEqualTo("VERITY TEST LTD");
    assertThat(receipt.receiverAccount()).isEqualTo("1****5909");
    assertThat(receipt.date()).isEqualTo("01-02-2026, 6:16:00 PM");
    assertThat(receipt.reference()).isEqualTo("FT26266ZN54F");
    assertThat(receipt.amount()).isEqualByComparingTo("1200.00");
    assertThat(receipt.looksLikeReceipt()).isTrue();
  }

  @Test
  void fallsBackToTotalDebitedOnlyWhenCreditedAmountIsMissing() {
    var receipt = CbeReceiptParser.parseText("ReceiverVERITY\nAccount1****5909\nTotal amount debited ETB 89.50");
    assertThat(receipt.amount()).isEqualByComparingTo(new BigDecimal("89.50"));
  }

  @Test
  void rejectsNegativeAndMalformedAmounts() {
    var negative = CbeReceiptParser.parseText("ReceiverVERITY\nTransferred Amount-89.50 ETB");
    var malformed = CbeReceiptParser.parseText("ReceiverVERITY\nTransferred Amount12,34.50 ETB");
    assertThat(negative.looksLikeReceipt()).isFalse();
    assertThat(malformed.looksLikeReceipt()).isFalse();
  }

  @Test
  void rejectsTextWithoutPaymentEvidence() {
    assertThat(CbeReceiptParser.parseText("CBE branch receipt").looksLikeReceipt()).isFalse();
    assertThat(CbeReceiptParser.parseText("ReceiverVERITY").looksLikeReceipt()).isFalse();
  }

  @Test
  void capsTextParsingWork() {
    String oversized = "x".repeat(200_001) + CBE_TEXT;
    assertThat(CbeReceiptParser.parseText(oversized).looksLikeReceipt()).isFalse();
    assertThat(CbeReceiptParser.parseText(CBE_TEXT).amount()).isEqualByComparingTo("1200.00");
  }
}
