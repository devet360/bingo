package com.verity.platform.provider.cbe;

import java.math.BigDecimal;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CbeReceiptParser {
  private static final Pattern MONEY = Pattern.compile("(?<![-0-9A-Za-z.,])(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?(?![0-9,.])");
  private static final Pattern REFERENCE_LABEL = Pattern.compile("^Reference No\\.\\s*\\(VAT Invoice No\\)\\s*", Pattern.CASE_INSENSITIVE);
  private static final Pattern RECEIPT_LABEL = Pattern.compile("^VAT Receipt No:\\s*", Pattern.CASE_INSENSITIVE);
  private static final Pattern DATE_LABEL = Pattern.compile("^(?:\\d+\\s+)?Payment Date & Time", Pattern.CASE_INSENSITIVE);
  private CbeReceiptParser() {}

  public static ParsedCbeReceipt parseText(String rawText) {
    String text = rawText == null ? "" : rawText.substring(0, Math.min(rawText.length(), 200_000));
    List<String> lines = text.lines()
        .map(line -> line.replaceAll("\\s+", " ").trim())
        .filter(line -> !line.isEmpty())
        .limit(2_000)
        .toList();

    String senderName = null;
    String senderAccount = null;
    String receiverName = null;
    String receiverAccount = null;
    String date = null;
    String reference = null;
    BigDecimal transferredAmount = null;
    BigDecimal totalDebited = null;
    Party party = Party.NONE;

    for (String line : lines) {
      String value = after("Payer", line);
      if (value != null) {
        senderName = value;
        party = Party.SENDER;
        continue;
      }
      value = after("Receiver", line);
      if (value != null) {
        receiverName = value;
        party = Party.RECEIVER;
        continue;
      }
      value = after("Account", line);
      if (value != null) {
        if (party == Party.SENDER && senderAccount == null) senderAccount = value;
        else if (party == Party.RECEIVER && receiverAccount == null) receiverAccount = value;
        continue;
      }
      if (DATE_LABEL.matcher(line).find()) {
        date = DATE_LABEL.matcher(line).replaceFirst("").trim();
        continue;
      }
      Matcher referenceMatcher = REFERENCE_LABEL.matcher(line);
      if (referenceMatcher.find()) {
        String valueAfterLabel = line.substring(referenceMatcher.end()).trim();
        if (!valueAfterLabel.isEmpty()) reference = valueAfterLabel;
        continue;
      }
      Matcher receiptMatcher = RECEIPT_LABEL.matcher(line);
      if (receiptMatcher.find() && reference == null) {
        String valueAfterLabel = line.substring(receiptMatcher.end()).trim();
        if (!valueAfterLabel.isEmpty()) reference = valueAfterLabel;
        continue;
      }
      if (startsWithIgnoreCase(line, "Transferred Amount") && transferredAmount == null) {
        transferredAmount = parseMoney(line.substring("Transferred Amount".length()));
        continue;
      }
      if (startsWithIgnoreCase(line, "Total amount debited") && totalDebited == null) {
        int digit = firstDigit(line);
        if (digit >= 0) totalDebited = parseMoney(line.substring(digit));
      }
    }

    BigDecimal credited = transferredAmount != null ? transferredAmount : totalDebited;
    return new ParsedCbeReceipt(
        senderName, senderAccount, receiverName, receiverAccount, date, reference, credited);
  }

  private static boolean present(String value) {
    return value != null && !value.isBlank();
  }

  private static String after(String label, String line) {
    if (!line.regionMatches(true, 0, label, 0, label.length())) return null;
    String value = line.substring(label.length()).trim();
    return value.isEmpty() ? null : value;
  }

  private static boolean startsWithIgnoreCase(String value, String prefix) {
    return value.regionMatches(true, 0, prefix, 0, prefix.length());
  }

  private static int firstDigit(String value) {
    for (int index = 0; index < value.length(); index++) {
      if (Character.isDigit(value.charAt(index))) return index;
    }
    return -1;
  }

  private static BigDecimal parseMoney(String value) {
    String bounded = value.substring(0, Math.min(value.length(), 200));
    Matcher matcher = MONEY.matcher(bounded);
    if (!matcher.find()) return null;
    try {
      return new BigDecimal(matcher.group().replace(",", ""));
    } catch (NumberFormatException ignored) {
      return null;
    }
  }

  public record ParsedCbeReceipt(
      String senderName,
      String senderAccount,
      String receiverName,
      String receiverAccount,
      String date,
      String reference,
      BigDecimal amount) {
    public boolean hasParty() {
      return present(senderName) || present(receiverName)
          || present(senderAccount) || present(receiverAccount);
    }

    public boolean looksLikeReceipt() {
      return amount != null && amount.signum() > 0 && hasParty();
    }
  }

  private enum Party { NONE, SENDER, RECEIVER }
}
