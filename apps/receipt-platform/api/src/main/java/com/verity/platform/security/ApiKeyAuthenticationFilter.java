package com.verity.platform.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

public class ApiKeyAuthenticationFilter extends OncePerRequestFilter {
  private static final Pattern KEY = Pattern.compile("rk_(?:test|live)_([A-Za-z0-9_-]{12,32})\\.([A-Za-z0-9_-]{32,})");
  private final JdbcTemplate jdbc;

  public ApiKeyAuthenticationFilter(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !request.getRequestURI().startsWith("/v1/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String authorization = request.getHeader("Authorization");
    if (authorization != null && authorization.startsWith("Bearer ")) {
      authenticate(authorization.substring(7)).ifPresent(principal -> {
        var authorities = principal.scopes().stream()
            .map(scope -> new SimpleGrantedAuthority("SCOPE_" + scope))
            .toList();
        var authentication = new UsernamePasswordAuthenticationToken(principal, null, authorities);
        SecurityContextHolder.getContext().setAuthentication(authentication);
      });
    }
    chain.doFilter(request, response);
  }

  private java.util.Optional<TenantPrincipal> authenticate(String token) {
    Matcher matcher = KEY.matcher(token);
    if (!matcher.matches()) return java.util.Optional.empty();
    String keyId = matcher.group(1);
    byte[] presentedDigest = sha256(matcher.group(2));
    var rows = jdbc.query(
        """
        SELECT o.id AS organization_id, p.id AS project_id, k.secret_digest, k.scopes
        FROM api_keys k
        JOIN projects p ON p.id = k.project_id
        JOIN organizations o ON o.id = p.organization_id
        WHERE k.key_id = ? AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())
        """,
        (rs, rowNum) -> new KeyRow(
            rs.getObject("organization_id", UUID.class),
            rs.getObject("project_id", UUID.class),
            rs.getBytes("secret_digest"),
            new HashSet<>(Arrays.asList((String[]) rs.getArray("scopes").getArray()))),
        keyId);
    if (rows.isEmpty() || !MessageDigest.isEqual(rows.get(0).digest(), presentedDigest)) {
      return java.util.Optional.empty();
    }
    KeyRow row = rows.get(0);
    jdbc.update("UPDATE api_keys SET last_used_at = now() WHERE key_id = ?", keyId);
    return java.util.Optional.of(new TenantPrincipal(row.organizationId(), row.projectId(), row.scopes()));
  }

  public static byte[] sha256(String value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException("SHA-256 is unavailable", exception);
    }
  }

  private record KeyRow(UUID organizationId, UUID projectId, byte[] digest, Set<String> scopes) {}
}
