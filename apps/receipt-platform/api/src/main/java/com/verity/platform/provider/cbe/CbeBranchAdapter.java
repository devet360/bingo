package com.verity.platform.provider.cbe;

import com.verity.platform.provider.ProviderAdapter;
import com.verity.platform.provider.ProviderUnavailableException;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(prefix = "providers.cbe", name = "enabled", havingValue = "true")
public class CbeBranchAdapter implements ProviderAdapter {
  private static final String SOURCE = "CBE_LEGACY_BRANCH_RECEIPT";
  private static final String BASE_URL = "https://apps.cbe.com.et:100/BranchReceipt/";
  private static final int MAX_RESPONSE_BYTES = 2_000_000;
  private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);
  private static final Pattern FAILED_BODY = Pattern.compile(
      "\\\"status\\\"\\s*:\\s*\\\"failed\\\"|please check your link|receipt data is not correct",
      Pattern.CASE_INSENSITIVE);
  private static final HttpClient HTTP = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(4))
      .followRedirects(HttpClient.Redirect.NEVER)
      .build();

  @Override
  public ProviderDescriptor descriptor() {
    return new ProviderDescriptor(
        "cbe", "ET", "ETB", SOURCE, "bank_endpoint", REQUEST_TIMEOUT, 30, true);
  }

  @Override
  public ProviderResult verify(ProviderRequest request) {
    String suffix = request.receiverAccountSuffix();
    if (suffix == null || !suffix.matches("[0-9]{8}")
        || request.reference() == null
        || request.reference().replaceAll("[^A-Za-z0-9]", "").length() < 3) {
      return result("INVALID_INPUT", Optional.empty(), Optional.empty());
    }

    URI uri = buildReceiptUri(request.reference(), suffix);
    HttpRequest httpRequest = HttpRequest.newBuilder(uri)
        .timeout(REQUEST_TIMEOUT)
        .header("Accept", "application/pdf,application/json,text/plain;q=0.9,*/*;q=0.8")
        .header("User-Agent", "Verity-Receipt-Platform/0.1")
        .GET()
        .build();

    final HttpResponse<InputStream> response;
    try {
      response = HTTP.send(httpRequest, HttpResponse.BodyHandlers.ofInputStream());
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new ProviderUnavailableException("CBE lookup was interrupted", exception);
    } catch (IOException exception) {
      throw new ProviderUnavailableException("CBE lookup did not complete", exception);
    }

    byte[] body;
    try (InputStream stream = response.body()) {
      body = stream.readNBytes(MAX_RESPONSE_BYTES + 1);
    } catch (IOException exception) {
      throw new ProviderUnavailableException("CBE response could not be read", exception);
    }
    if (body.length > MAX_RESPONSE_BYTES) {
      return result("UNREADABLE", Optional.empty(), Optional.empty());
    }

    String bodyPrefix = new String(body, 0, Math.min(body.length, 2_000), StandardCharsets.UTF_8);
    if (FAILED_BODY.matcher(bodyPrefix).find() || response.statusCode() == 404) {
      return result("NOT_FOUND", Optional.empty(), Optional.empty());
    }
    if (response.statusCode() >= 500) {
      throw new ProviderUnavailableException("CBE returned HTTP " + response.statusCode());
    }
    if (response.statusCode() != 200 || !isPdf(body)) {
      return result("UNREADABLE", Optional.empty(), Optional.empty());
    }

    CbeReceiptParser.ParsedCbeReceipt receipt = parsePdf(body);
    if (!receipt.looksLikeReceipt() || receipt.reference() == null || receipt.reference().isBlank()) {
      return result("UNREADABLE", Optional.ofNullable(receipt.amount()), Optional.empty());
    }
    if (!receiverSuffixMatches(receipt.receiverAccount(), suffix)) {
      return result("NOT_MATCHED", Optional.of(receipt.amount()), Optional.of(receipt.reference()));
    }
    return new ProviderResult(
        "SUCCESS", SOURCE, true, Optional.of(receipt.amount()), Optional.of("ETB"),
        Optional.of(receipt.reference()));
  }

  static URI buildReceiptUri(String reference, String accountSuffix) {
    String normalized = reference.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT);
    if (normalized.length() < 3 || normalized.length() > 128 || !accountSuffix.matches("[0-9]{8}")) {
      throw new IllegalArgumentException("Invalid CBE lookup input");
    }
    return URI.create(BASE_URL + URLEncoder.encode(normalized, StandardCharsets.UTF_8)
        + "&" + URLEncoder.encode(accountSuffix, StandardCharsets.UTF_8));
  }

  static boolean receiverSuffixMatches(String maskedReceiverAccount, String expectedSuffix) {
    if (maskedReceiverAccount == null || expectedSuffix == null || !expectedSuffix.matches("[0-9]{8}")) {
      return false;
    }
    var matcher = Pattern.compile("([0-9]{4,})$").matcher(maskedReceiverAccount);
    if (!matcher.find()) return false;
    String visibleDigits = matcher.group(1);
    if (visibleDigits.length() > 8) visibleDigits = visibleDigits.substring(visibleDigits.length() - 8);
    return expectedSuffix.endsWith(visibleDigits);
  }

  private static CbeReceiptParser.ParsedCbeReceipt parsePdf(byte[] body) {
    try (PDDocument document = Loader.loadPDF(body)) {
      if (document.getNumberOfPages() == 0) return CbeReceiptParser.parseText("");
      PDFTextStripper stripper = new PDFTextStripper();
      stripper.setStartPage(1);
      stripper.setEndPage(Math.min(document.getNumberOfPages(), 3));
      return CbeReceiptParser.parseText(stripper.getText(document));
    } catch (IOException | RuntimeException exception) {
      return CbeReceiptParser.parseText("");
    }
  }

  private static boolean isPdf(byte[] body) {
    return body.length >= 5 && body[0] == '%' && body[1] == 'P'
        && body[2] == 'D' && body[3] == 'F' && body[4] == '-';
  }

  private ProviderResult result(String state, Optional<BigDecimal> amount, Optional<String> reference) {
    return new ProviderResult(state, SOURCE, true, amount, Optional.of("ETB"), reference);
  }
}
