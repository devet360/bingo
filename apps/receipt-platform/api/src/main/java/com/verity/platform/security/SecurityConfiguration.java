package com.verity.platform.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.jdbc.core.JdbcTemplate;

@Configuration
@EnableMethodSecurity
public class SecurityConfiguration {
  @Bean
  SecurityFilterChain apiSecurity(HttpSecurity http, JdbcTemplate jdbc)
      throws Exception {
    var apiKeyFilter = new ApiKeyAuthenticationFilter(jdbc);
    return http
        .csrf(csrf -> csrf.ignoringRequestMatchers("/v1/**", "/telegram/**"))
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(authorize -> authorize
            .requestMatchers("/actuator/health/**", "/actuator/info", "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
            .requestMatchers("/telegram/webhook", "/telegram/mini-app/auth").permitAll()
            .requestMatchers("/v1/**").authenticated()
            .anyRequest().denyAll())
        .exceptionHandling(errors -> errors
            .authenticationEntryPoint((request, response, exception) -> {
              response.setStatus(401);
              response.setContentType("application/problem+json");
              response.getWriter().write("{\"type\":\"about:blank\",\"title\":\"Unauthorized\",\"status\":401,\"code\":\"INVALID_API_KEY\"}");
            })
            .accessDeniedHandler((request, response, exception) -> {
              response.setStatus(403);
              response.setContentType("application/problem+json");
              response.getWriter().write("{\"type\":\"about:blank\",\"title\":\"Forbidden\",\"status\":403,\"code\":\"INSUFFICIENT_SCOPE\"}");
            }))
        .addFilterBefore(apiKeyFilter, AnonymousAuthenticationFilter.class)
        .httpBasic(basic -> basic.disable())
        .formLogin(form -> form.disable())
        .build();
  }
}
