package com.verity.platform.api;

import java.util.List;

public record VerificationPageResponse(
    List<VerificationResponse> data,
    int page,
    int size,
    boolean hasMore) {}
