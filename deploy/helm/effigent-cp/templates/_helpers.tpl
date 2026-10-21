{{- define "effigent-cp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "effigent-cp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains (include "effigent-cp.name" .) .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "effigent-cp.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "effigent-cp.labels" -}}
app.kubernetes.io/name: {{ include "effigent-cp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "effigent-cp.selector" -}}
app.kubernetes.io/name: {{ include "effigent-cp.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "effigent-cp.keysSecret" -}}
{{- .Values.keys.existingSecret | default (printf "%s-keys" (include "effigent-cp.fullname" .)) -}}
{{- end -}}

{{- define "effigent-cp.configSecret" -}}
{{- printf "%s-config" (include "effigent-cp.fullname" .) -}}
{{- end -}}

{{- define "effigent-cp.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "effigent-cp.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name | default "default" -}}
{{- end -}}
{{- end -}}

{{- define "effigent-cp.cpURL" -}}
{{- required "set controlPlane.url (the control plane's public URL, e.g. https://effigent-api.example.com)" .Values.controlPlane.url | trimSuffix "/" -}}
{{- end -}}

{{- define "effigent-cp.consoleURL" -}}
{{- required "set console.url (the console's public URL, e.g. https://effigent.example.com)" .Values.console.url | trimSuffix "/" -}}
{{- end -}}

{{/* scheme://host[:port] of the console: the CORS origin the control plane allows. */}}
{{- define "effigent-cp.consoleOrigin" -}}
{{- $u := urlParse (include "effigent-cp.consoleURL" .) -}}
{{- printf "%s://%s" $u.scheme $u.host -}}
{{- end -}}

{{- define "effigent-cp.image" -}}
{{- printf "%s:%s" .image.repository (.image.tag | default .root.Chart.AppVersion) -}}
{{- end -}}

{{- define "effigent-cp.postgresHost" -}}
{{- printf "%s-postgres" (include "effigent-cp.fullname" .) -}}
{{- end -}}

{{/* A secret-backed env var: from a user's Secret, else from the chart's config Secret. */}}
{{- define "effigent-cp.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      {{- if .existing }}
      name: {{ .existing }}
      key: {{ .existingKey }}
      {{- else }}
      name: {{ include "effigent-cp.configSecret" .root }}
      key: {{ .key }}
      {{- end }}
{{- end -}}

{{- define "effigent-cp.caEnv" -}}
{{- if .Values.caBundle.configMap }}
# Go adds every PEM file in SSL_CERT_DIR to the system roots; Node adds NODE_EXTRA_CA_CERTS.
- name: SSL_CERT_DIR
  value: /etc/effigent/ca
- name: NODE_EXTRA_CA_CERTS
  value: /etc/effigent/ca/{{ .Values.caBundle.key }}
{{- end }}
{{- end -}}

{{- define "effigent-cp.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "effigent-cp.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end -}}
