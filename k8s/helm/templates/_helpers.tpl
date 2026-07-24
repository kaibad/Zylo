{{/*
Expand the name of the chart.
*/}}
{{- define "zylo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "zylo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "zylo.labels" -}}
helm.sh/chart: {{ include "zylo.chart" . }}
{{ include "zylo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "zylo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "zylo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
