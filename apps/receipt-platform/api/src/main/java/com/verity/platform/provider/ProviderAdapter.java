package com.verity.platform.provider;

import java.math.BigDecimal;
import java.time.Duration;
import java.util.Optional;

public interface ProviderAdapter {
  ProviderDescriptor descriptor();

  ProviderResult verify(ProviderRequest request);

  record ProviderDescriptor(
      String code,
      String country,
      String currency,
      String source,
      String trustLevel,
      Duration timeout,
      int requestsPerMinute,
      boolean authoritative) {}

  record ProviderRequest(String reference, BigDecimal expectedAmount, String expectedCurrency, String receiverAccountSuffix) {}

  record ProviderResult(
      String providerState,
      String source,
      boolean authoritative,
      Optional<BigDecimal> amount,
      Optional<String> currency,
      Optional<String> normalizedReference) {}
}
