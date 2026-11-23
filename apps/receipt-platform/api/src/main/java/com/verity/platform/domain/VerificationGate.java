package com.verity.platform.domain;

import com.verity.platform.provider.ProviderAdapter.ProviderRequest;
import com.verity.platform.provider.ProviderAdapter.ProviderResult;
import java.util.Objects;
import java.util.Locale;

public final class VerificationGate {
  private VerificationGate() {}

  private static String normalize(String reference) {
    return reference.replaceAll("[^A-Za-z0-9]", "").toUpperCase(Locale.ROOT);
  }

  public static VerificationStatus evaluate(ProviderRequest expected, ProviderResult result) {
    String providerState = result.providerState() == null ? "" : result.providerState().toUpperCase();
    if (!result.authoritative()) return VerificationStatus.MANUAL_REVIEW;
    switch (providerState) {
      case "PENDING", "PROCESSING" -> { return VerificationStatus.PENDING; }
      case "NOT_FOUND", "NOTFOUND" -> { return VerificationStatus.NOT_FOUND; }
      case "NOT_MATCHED" -> { return VerificationStatus.NOT_MATCHED; }
      case "INVALID_INPUT" -> { return VerificationStatus.INVALID_INPUT; }
      case "FAILED", "DECLINED", "CANCELLED" -> { return VerificationStatus.FAILED; }
      case "SUCCESS" -> { }
      default -> { return VerificationStatus.MANUAL_REVIEW; }
    }
    if (expected.expectedAmount() != null
        && (result.amount().isEmpty()
            || expected.expectedAmount().compareTo(result.amount().get()) != 0)) {
      return VerificationStatus.NOT_MATCHED;
    }
    if (expected.expectedCurrency() != null
        && (result.currency().isEmpty()
            || !Objects.equals(expected.expectedCurrency(), result.currency().get()))) {
      return VerificationStatus.NOT_MATCHED;
    }
    if (result.normalizedReference().isEmpty()
        || !normalize(expected.reference()).equals(normalize(result.normalizedReference().get()))) {
      return VerificationStatus.NOT_MATCHED;
    }
    return VerificationStatus.VERIFIED;
  }
}
