# Build context is the repository root:
#   docker build -f examples/partner-embed-java/Dockerfile .
FROM docker.io/library/eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY examples/partner-embed-java/PartnerServer.java .
RUN javac -d /out PartnerServer.java

FROM docker.io/library/eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /out /app/classes
COPY sdk/dist /app/sdk
ENV SDK_DIST=/app/sdk \
    PAGE_TLS=false \
    BIND_HOST=0.0.0.0 \
    PAGE_PORT=8080 \
    CALLBACK_PORT=0
RUN useradd --uid 10001 --no-create-home partner
USER 10001
EXPOSE 8080
CMD ["java", "-XX:MaxRAMPercentage=75", "-cp", "/app/classes", "PartnerServer"]
