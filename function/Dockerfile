# Built on the Workpeg function base: Python 3.12, this SDK at one exact
# version, a non-root user (appuser, 10001), WORKDIR /app and the runtime's
# ENTRYPOINT. `workpeg project create` wrote the version of the SDK it ran as.
FROM registry.gitlab.com/workpeg/workpeg-sdk/pegfn-base:0.158.0

# Workpeg builds this image with no network, so nothing here may download.
# Extra packages come from wheels/, filled before you build or submit by
# running pip inside this FROM image (wheels/README.txt has the command).
# Never list workpeg itself: the base already has it.
COPY wheels /wheels
COPY requirements.txt /app/requirements.txt
USER root
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r /app/requirements.txt
USER appuser

COPY app /app/app
