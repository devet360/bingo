package com.verity.platform.api;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfiguration {
  @Bean
  OpenAPI receiptPlatformOpenApi() {
    return new OpenAPI()
        .info(new Info()
            .title("Verity Receipt Verification API")
            .version("v1")
            .description("API contract for tenant-scoped receipt verification. A provider is not considered supported until its authoritative adapter is enabled and tested."))
        .components(new Components().addSecuritySchemes(
            "apiKeyBearer",
            new SecurityScheme()
                .type(SecurityScheme.Type.HTTP)
                .scheme("bearer")
                .bearerFormat("rk_test_<key-id>.<secret>")));
  }
}
