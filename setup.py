import setuptools

with open('requirements.txt') as file:
   install_deps = [line for line in file]

with open('README.rst', 'r') as fh:
   long_description = fh.read()

setuptools.setup(
   name='a3em',
   version='1.0.3',
   author='Will Hedgecock',
   author_email='ronald.w.hedgecock@vanderbilt.edu',
   description='A3EM Management Dashboard',
   long_description=long_description,
   long_description_content_type='text/x-rst',
   url='https://github.com/hedgecrw/A3EM',
   package_dir={'a3em': 'dashboard'},
   packages=['a3em'],
   include_package_data=True,
   install_requires=install_deps,
   classifiers=[
      'Programming Language :: Python :: 3',
      'Operating System :: OS Independent',
   ],
   python_requires='>=3.8',
   entry_points={
      'console_scripts': ['a3em = a3em.dashboard:main'],
   }
)
