package com.verity.platform.provider;

import java.util.Collection;
import java.util.Map;
import java.util.Optional;
import java.util.Locale;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
public class ProviderRegistry {
  private final Map<String, ProviderAdapter> adapters;

  public ProviderRegistry(Collection<ProviderAdapter> adapters) {
    this.adapters = adapters.stream()
        .collect(Collectors.toUnmodifiableMap(
            adapter -> adapter.descriptor().code().toLowerCase(Locale.ROOT), Function.identity()));
  }

  public Optional<ProviderAdapter> find(String code) {
    return Optional.ofNullable(adapters.get(code.toLowerCase(Locale.ROOT)));
  }
}
