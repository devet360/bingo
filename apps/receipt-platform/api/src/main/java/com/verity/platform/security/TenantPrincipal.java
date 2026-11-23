package com.verity.platform.security;

import java.util.Set;
import java.util.UUID;

public record TenantPrincipal(UUID organizationId, UUID projectId, Set<String> scopes) {}
