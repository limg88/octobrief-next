"""The caps of the renderer. Those of a template are the same as the core's (`recipe/template.ts`):
the shared hostile corpus checks that both sides refuse the same files."""

MAX_TEMPLATE_BYTES = 10 * 1024 * 1024
MAX_TEMPLATE_EXPANDED_BYTES = 50 * 1024 * 1024
MAX_TEMPLATE_ENTRIES = 2000
MAX_TEMPLATE_XML_DEPTH = 256

# A produced file is held to the same caps as a template: it is a template plus the document.
MAX_FILE_BYTES = MAX_TEMPLATE_BYTES
MAX_FILE_EXPANDED_BYTES = MAX_TEMPLATE_EXPANDED_BYTES

# The body of a request: a template in base64 (4/3 of its size) and a document.
MAX_REQUEST_BYTES = 20 * 1024 * 1024

# One request: wall time, CPU time and address space of the child process that renders it.
RENDER_TIMEOUT_SECONDS = 60
RENDER_CPU_SECONDS = 60
RENDER_MEMORY_BYTES = 768 * 1024 * 1024
